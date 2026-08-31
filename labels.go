package main

// Local labels: names the reader puts on conversations, kept in Oreneta's own
// store. The bridge only carries them through — nothing here decides anything.

import "errors"

// labelsList returns the labels as they were arranged.
func (a *App) labelsList(map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"labels": []any{}}, nil
	}
	return a.sidecar.Call("labels.list", map[string]any{})
}

// labelsSave replaces the whole set. A label that is gone takes its
// conversations with it, so nothing carries a label nobody can see or remove.
func (a *App) labelsSave(payload map[string]any) (any, error) {
	list, ok := payload["labels"].([]any)
	if !ok {
		return nil, errors.New("invalid labels")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("labels.save", map[string]any{"labels": list})
}

// labelsAssign states the whole set of labels on one conversation.
func (a *App) labelsAssign(payload map[string]any) (any, error) {
	threadID, _ := payload["thread_id"].(string)
	if threadID == "" {
		return nil, errors.New("invalid thread")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	ids, _ := payload["label_ids"].([]any)
	if ids == nil {
		ids = []any{}
	}
	return a.sidecar.Call("labels.assign", map[string]any{
		"thread_id": threadID,
		"label_ids": ids,
	})
}
