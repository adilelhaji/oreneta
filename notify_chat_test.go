package main

import (
	"testing"
	"time"
)

// Chat notifications (ADR-0055): the core says which messages deserve one;
// the bridge raises it with the conversation as the click target, and holds
// it back under do not disturb and quiet hours like mail, even when
// reminders are allowed through.
func TestChatNotificationRaisedAndHeldBackWhileQuiet(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(5_000))
	a := &App{}
	direct := map[string]any{
		"account": "chat-1", "conversation": "pau@chat.test", "kind": "chat",
		"title": "pau@chat.test", "body": "Hola",
	}
	private := map[string]any{
		"account": "chat-1", "conversation": "team@rooms.chat.test/Pau", "kind": "private",
		"title": "Pau · team@rooms.chat.test", "body": "En privado",
	}

	a.handleSidecarEvent("chat.notify", direct)
	a.handleSidecarEvent("chat.notify", private)
	if len(*got) != 2 {
		t.Fatalf("not quiet: %d notifications, want 2", len(*got))
	}
	first, second := (*got)[0], (*got)[1]
	if first.title != "pau@chat.test" || first.body != "Hola" || first.account != "chat-1" ||
		first.threadID != "chat:pau@chat.test" {
		t.Fatalf("direct: %+v", first)
	}
	if second.title != "Pau · team@rooms.chat.test" || second.threadID != "chat:team@rooms.chat.test/Pau" {
		t.Fatalf("private: %+v", second)
	}

	// Do not disturb, with reminders still allowed: chat is held back.
	if _, err := a.setNotifyQuiet(map[string]any{"indefinite": true, "remindersWhileQuiet": true, "quiet": true}); err != nil {
		t.Fatal(err)
	}
	*got = nil
	a.handleSidecarEvent("chat.notify", direct)
	if len(*got) != 0 {
		t.Fatalf("do not disturb: %+v", *got)
	}

	// Quiet hours over: they go through again.
	_, _ = a.setNotifyQuiet(map[string]any{"intervals": []any{[]any{float64(0), float64(4_000)}}})
	a.handleSidecarEvent("chat.notify", direct)
	if len(*got) != 1 {
		t.Fatalf("after quiet hours: %d notifications, want 1", len(*got))
	}
}

func TestChatNotificationNeedsAccountAndConversation(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(0))
	a := &App{}
	a.handleSidecarEvent("chat.notify", map[string]any{"account": "chat-1", "body": "x"})
	a.handleSidecarEvent("chat.notify", map[string]any{"conversation": "pau@chat.test", "body": "x"})
	a.handleSidecarEvent("chat.notify", "not an object")
	if len(*got) != 0 {
		t.Fatalf("malformed events raised %+v", *got)
	}
	// Without a title, the conversation names it.
	a.handleSidecarEvent("chat.notify", map[string]any{"account": "chat-1", "conversation": "pau@chat.test", "body": "x"})
	if len(*got) != 1 || (*got)[0].title != "pau@chat.test" {
		t.Fatalf("no title: %+v", *got)
	}
}

// What someone typed reaches the notification service as text: freedesktop
// markup does not obey it, and the Windows toast XML cannot be broken out of.
func TestChatNotificationTextStaysText(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(0))
	a := &App{}
	a.handleSidecarEvent("chat.notify", map[string]any{
		"account": "chat-1", "conversation": "team@rooms.chat.test/<b>", "title": "x", "body": "<b>hola</b> & adiós",
	})
	if len(*got) != 1 || !(*got)[0].plainBody {
		t.Fatalf("a chat body is plain text: %+v", *got)
	}
	if m := markupText("<b>hola</b> & adiós"); m != "&lt;b&gt;hola&lt;/b&gt; &amp; adiós" {
		t.Fatalf("markupText = %q", m)
	}
	if s := toastText("a ]]> <x/>"); s != "a ]]]]><![CDATA[> <x/>" {
		t.Fatalf("toastText = %q", s)
	}
	if s := toastAttr(`chat-1|team@rooms.chat.test/"P&u'<>`); s != "chat-1|team@rooms.chat.test/&quot;P&amp;u&apos;&lt;&gt;" {
		t.Fatalf("toastAttr = %q", s)
	}
	// Mail keeps its body as it was.
	*got = nil
	a.handleSidecarEvent("mail.newMessages", map[string]any{"account": "acc", "count": float64(1), "from": "Ana", "subject": "Hi"})
	if len(*got) != 1 || (*got)[0].plainBody {
		t.Fatalf("mail: %+v", *got)
	}
}
