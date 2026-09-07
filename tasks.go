package main

// Local, message-tied tasks: thin passthroughs to the sidecar, same shape as
// oof.go and spam.go. All the logic — the "one open task per conversation"
// rule included — lives in meron-core; nothing here decides anything.

import "errors"

// tasksList reports every task, across every account and folder.
func (a *App) tasksList(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	params := map[string]any{}
	if includeCompleted, ok := payload["include_completed"].(bool); ok {
		params["include_completed"] = includeCompleted
	}
	return a.sidecar.Call("tasks.list", params)
}

// tasksSave creates a task on a conversation, or edits the one already open
// on it.
func (a *App) tasksSave(payload map[string]any) (any, error) {
	threadID, _ := payload["thread_id"].(string)
	if threadID == "" {
		return nil, errors.New("invalid thread")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	params := map[string]any{"thread_id": threadID}
	if dueAt, ok := payload["due_at"].(float64); ok {
		params["due_at"] = int64(dueAt)
	}
	if note, ok := payload["note"].(string); ok {
		params["note"] = note
	}
	return a.sidecar.Call("tasks.save", params)
}

// tasksSetCompleted marks a task done, or takes that back.
func (a *App) tasksSetCompleted(payload map[string]any) (any, error) {
	id, ok := payload["id"].(float64)
	if !ok {
		return nil, errors.New("invalid task id")
	}
	completed, ok := payload["completed"].(bool)
	if !ok {
		return nil, errors.New("missing completed")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("tasks.setCompleted", map[string]any{"id": int64(id), "completed": completed})
}

// tasksDelete removes a task outright.
func (a *App) tasksDelete(payload map[string]any) (any, error) {
	id, ok := payload["id"].(float64)
	if !ok {
		return nil, errors.New("invalid task id")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("tasks.delete", map[string]any{"id": int64(id)})
}
