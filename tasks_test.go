package main

import "testing"

func TestTasksListPassesIncludeCompletedThrough(t *testing.T) {
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"tasks": []any{}}},
	)
	if _, err := app.tasksList(map[string]any{"include_completed": true}); err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "tasks.list", map[string]any{"include_completed": true})
}

func TestTasksListOmitsIncludeCompletedWhenAbsent(t *testing.T) {
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"tasks": []any{}}},
	)
	if _, err := app.tasksList(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "tasks.list", map[string]any{})
}

func TestTasksGetPassesIdThrough(t *testing.T) {
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"due_at": float64(1234), "note": "Old note"}},
	)
	out, err := app.tasksGet(map[string]any{"id": float64(7)})
	if err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "tasks.get", map[string]any{"id": float64(7)})
	if got := out.(map[string]any)["note"]; got != "Old note" {
		t.Fatalf("note = %v, want %q", got, "Old note")
	}
}

func TestTasksGetRejectsAMissingId(t *testing.T) {
	app, _ := newMailHandlerTestApp(t)
	if _, err := app.tasksGet(map[string]any{}); err == nil {
		t.Fatal("want an error for a missing id")
	}
}

func TestTasksSavePassesDueAtAndNoteThrough(t *testing.T) {
	threadID := formatImapThreadID("acc", "INBOX", "k1#Todo")
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"ok": true, "id": float64(7)}},
	)
	out, err := app.tasksSave(map[string]any{"thread_id": threadID, "due_at": float64(1234), "note": "Follow up"})
	if err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "tasks.save", map[string]any{
		"thread_id": threadID,
		"due_at":    float64(1234),
		"note":      "Follow up",
	})
	if got := out.(map[string]any)["id"]; got != float64(7) {
		t.Fatalf("id = %v, want 7", got)
	}
}

func TestTasksSaveRejectsAnEmptyThread(t *testing.T) {
	app, _ := newMailHandlerTestApp(t)
	if _, err := app.tasksSave(map[string]any{}); err == nil {
		t.Fatal("want an error for a missing thread_id")
	}
}

func TestTasksSetCompletedPassesIdAndCompletedThrough(t *testing.T) {
	app, writer := newMailHandlerTestApp(t, sidecarResponsePlan{Result: map[string]any{"ok": true}})
	if _, err := app.tasksSetCompleted(map[string]any{"id": float64(3), "completed": true}); err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "tasks.setCompleted", map[string]any{"id": float64(3), "completed": true})
}

func TestTasksSetCompletedRejectsMissingFields(t *testing.T) {
	app, _ := newMailHandlerTestApp(t)
	if _, err := app.tasksSetCompleted(map[string]any{"completed": true}); err == nil {
		t.Fatal("want an error for a missing id")
	}
	if _, err := app.tasksSetCompleted(map[string]any{"id": float64(1)}); err == nil {
		t.Fatal("want an error for a missing completed")
	}
}

func TestTasksDeletePassesIdThrough(t *testing.T) {
	app, writer := newMailHandlerTestApp(t, sidecarResponsePlan{Result: map[string]any{"ok": true}})
	if _, err := app.tasksDelete(map[string]any{"id": float64(9)}); err != nil {
		t.Fatal(err)
	}
	assertCall(t, writer.calls[0], "tasks.delete", map[string]any{"id": float64(9)})
}

func TestTasksDeleteRejectsAMissingId(t *testing.T) {
	app, _ := newMailHandlerTestApp(t)
	if _, err := app.tasksDelete(map[string]any{}); err == nil {
		t.Fatal("want an error for a missing id")
	}
}
