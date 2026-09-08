package main

import "testing"

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
		"thread_id": threadID,
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
		"thread_id": threadID,
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
