package main

import (
	"reflect"
	"testing"
)

func TestMailMarkJunkRecordsASpamJudgmentAfterMoving(t *testing.T) {
	threadID := formatImapThreadID("acc", "INBOX", "k1#Todo")
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"folder": "Junk"}},
		sidecarResponsePlan{Result: map[string]any{"ok": true, "moved": float64(1)}},
		sidecarResponsePlan{Result: map[string]any{"ok": true, "sender": "spammer@example.com"}},
	)

	if _, err := app.mailMarkJunk(map[string]any{"thread_id": threadID, "junk": true}); err != nil {
		t.Fatal(err)
	}
	if len(writer.calls) != 3 {
		t.Fatalf("sidecar calls = %#v, want three (byRole, move, judgment)", writer.calls)
	}
	assertCall(t, writer.calls[2], "mail.recordSpamJudgment", map[string]any{
		"thread_id": formatImapThreadID("acc", "Junk", "k1#Todo"),
		"spam":      true,
	})
}

func TestMailMarkJunkUnmarkingRecordsAHamJudgment(t *testing.T) {
	threadID := formatImapThreadID("acc", "Junk", "k1#Todo")
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"folder": "INBOX"}},
		sidecarResponsePlan{Result: map[string]any{"ok": true, "moved": float64(1)}},
		sidecarResponsePlan{Result: map[string]any{"ok": true}},
	)

	if _, err := app.mailMarkJunk(map[string]any{"thread_id": threadID, "junk": false}); err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[2], "mail.recordSpamJudgment", map[string]any{
		"thread_id": formatImapThreadID("acc", "INBOX", "k1#Todo"),
		"spam":      false,
	})
}

// The move itself already succeeded; a learning call that fails afterward
// must not turn a successful mark-junk into a reported failure.
func TestMailMarkJunkSucceedsEvenWhenRecordingTheJudgmentFails(t *testing.T) {
	threadID := formatImapThreadID("acc", "INBOX", "k1#Todo")
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"folder": "Junk"}},
		sidecarResponsePlan{Result: map[string]any{"ok": true, "moved": float64(1)}},
		sidecarResponsePlan{Error: "boom"},
	)

	out, err := app.mailMarkJunk(map[string]any{"thread_id": threadID, "junk": true})
	if err != nil {
		t.Fatalf("mailMarkJunk returned an error even though the move succeeded: %v", err)
	}
	if got := out.(map[string]any)["moved"]; got != float64(1) {
		t.Fatalf("moved = %v, want 1", got)
	}
	if len(writer.calls) != 3 {
		t.Fatalf("sidecar calls = %#v, want three", writer.calls)
	}
}

func TestMailSpamReasonPassesTheThreadThrough(t *testing.T) {
	threadID := formatImapThreadID("acc", "INBOX", "k1#Todo")
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"spam": true, "reasons": []any{"senderMarkedBefore"}, "sender": "spammer@example.com"}},
	)

	out, err := app.mailSpamReason(map[string]any{"thread_id": threadID})
	if err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "mail.spamReason", map[string]any{"thread_id": threadID})
	if got := out.(map[string]any)["spam"]; got != true {
		t.Fatalf("spam = %v, want true", got)
	}
}

func TestMailSpamReasonRejectsAnEmptyThread(t *testing.T) {
	app, _ := newMailHandlerTestApp(t)
	if _, err := app.mailSpamReason(map[string]any{}); err == nil {
		t.Fatal("want an error for a missing thread_id")
	}
}

func TestMailRecordSpamJudgmentPassesTheJudgmentThrough(t *testing.T) {
	threadID := formatImapThreadID("acc", "INBOX", "k1#Todo")
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"ok": true, "sender": "someone@example.com"}},
	)

	if _, err := app.mailRecordSpamJudgment(map[string]any{"thread_id": threadID, "spam": false}); err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "mail.recordSpamJudgment", map[string]any{
		"thread_id": threadID,
		"spam":      false,
	})
}

func TestMailRecordSpamJudgmentRejectsMissingFields(t *testing.T) {
	threadID := formatImapThreadID("acc", "INBOX", "k1#Todo")
	app, _ := newMailHandlerTestApp(t)

	if _, err := app.mailRecordSpamJudgment(map[string]any{"spam": true}); err == nil {
		t.Fatal("want an error for a missing thread_id")
	}
	if _, err := app.mailRecordSpamJudgment(map[string]any{"thread_id": threadID}); err == nil {
		t.Fatal("want an error for a missing spam judgment")
	}
}

// A judgment change as the core answers it (#254): the judgment row before
// and after the mark, for the undo to take back.
func sampleSpamJudgment() map[string]any {
	return map[string]any{
		"account":    "acc",
		"message_id": float64(7),
		"before":     nil,
		"after":      map[string]any{"spam": true, "from_addr": "spammer@example.com", "subject": "Win"},
	}
}

func TestMailMarkJunkReturnsTheJudgmentChangeForItsUndo(t *testing.T) {
	threadID := formatImapThreadID("acc", "INBOX", "k1#Todo")
	app, _ := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"folder": "Junk"}},
		sidecarResponsePlan{Result: map[string]any{"ok": true, "moved": float64(1)}},
		sidecarResponsePlan{Result: map[string]any{"ok": true, "sender": "spammer@example.com", "judgment": sampleSpamJudgment()}},
	)

	out, err := app.mailMarkJunk(map[string]any{"thread_id": threadID, "junk": true})
	if err != nil {
		t.Fatal(err)
	}
	if got := out.(map[string]any)["spam_judgment"]; !reflect.DeepEqual(got, sampleSpamJudgment()) {
		t.Fatalf("spam_judgment = %#v, want %#v", got, sampleSpamJudgment())
	}
}

// Nothing recorded, nothing to take back: no judgment rides on the result.
func TestMailMarkJunkReturnsNoJudgmentWhenNoneWasRecorded(t *testing.T) {
	for name, recorded := range map[string]sidecarResponsePlan{
		"no conversation": {Result: map[string]any{"ok": true, "sender": nil, "judgment": nil}},
		"failed":          {Error: "boom"},
	} {
		t.Run(name, func(t *testing.T) {
			threadID := formatImapThreadID("acc", "INBOX", "k1#Todo")
			app, _ := newMailHandlerTestApp(t,
				sidecarResponsePlan{Result: map[string]any{"folder": "Junk"}},
				sidecarResponsePlan{Result: map[string]any{"ok": true, "moved": float64(1)}},
				recorded,
			)

			out, err := app.mailMarkJunk(map[string]any{"thread_id": threadID, "junk": true})
			if err != nil {
				t.Fatal(err)
			}
			if _, present := out.(map[string]any)["spam_judgment"]; present {
				t.Fatalf("spam_judgment present in %#v, want absent", out)
			}
		})
	}
}

func TestMailRevertSpamJudgmentPassesTheChangeThrough(t *testing.T) {
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"ok": true, "reverted": true, "judgment": map[string]any{}}},
	)

	out, err := app.mailRevertSpamJudgment(map[string]any{"judgment": sampleSpamJudgment()})
	if err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "mail.revertSpamJudgment", map[string]any{"judgment": sampleSpamJudgment()})
	if got := out.(map[string]any)["reverted"]; got != true {
		t.Fatalf("reverted = %v, want true", got)
	}
}

func TestMailRevertSpamJudgmentRejectsAMissingChange(t *testing.T) {
	app, writer := newMailHandlerTestApp(t)
	for _, payload := range []map[string]any{{}, {"judgment": "not an object"}, {"judgment": nil}} {
		if _, err := app.mailRevertSpamJudgment(payload); err == nil {
			t.Fatalf("want an error for %#v", payload)
		}
	}
	if len(writer.calls) != 0 {
		t.Fatalf("sidecar calls = %#v, want none", writer.calls)
	}
}

func TestInvokeRoutesRevertSpamJudgment(t *testing.T) {
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"ok": true, "reverted": false, "judgment": nil}},
	)

	if _, err := app.invoke("mail.revertSpamJudgment", map[string]any{"judgment": sampleSpamJudgment()}); err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "mail.revertSpamJudgment", map[string]any{"judgment": sampleSpamJudgment()})
}
