package main

// Text the writer keeps because they write it often — a snippet dropped in at
// the cursor, or a whole message with its own subject. Kept in Oreneta's own
// store; the bridge carries it through and decides nothing.

import "errors"

// templatesList returns the templates as they were arranged.
//
// An engine that has not started yet answers with an empty list rather than an
// error: the composer asks for these while opening, and a toolbar that failed
// to load would be a worse answer than one with nothing in it yet.
func (a *App) templatesList(map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"templates": []any{}}, nil
	}
	return a.sidecar.Call("templates.list", map[string]any{})
}

// templatesSave replaces the whole set, arrangement included.
func (a *App) templatesSave(payload map[string]any) (any, error) {
	list, ok := payload["templates"].([]any)
	if !ok {
		return nil, errors.New("invalid templates")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("templates.save", map[string]any{"templates": list})
}
