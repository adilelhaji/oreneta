package main

// Local rules: what the reader has asked to happen to mail as it arrives.
//
// The bridge only carries these through. Everything that decides or acts
// lives in the core, because rules must run when mail arrives — which is
// whenever the core is running, not whenever a window happens to be open.

import "errors"

// rulesList returns the rules as they stand, in the order they run.
func (a *App) rulesList(map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"rules": []any{}}, nil
	}
	return a.sidecar.Call("rules.list", map[string]any{})
}

// rulesSave replaces the whole list. All at once: the order is part of the
// meaning, since rules run top to bottom and one of them can stop the rest.
func (a *App) rulesSave(payload map[string]any) (any, error) {
	list, ok := payload["rules"].([]any)
	if !ok {
		return nil, errors.New("invalid rules")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("rules.save", map[string]any{"rules": list})
}

// rulesPreview reports what the rules would do to mail already in a folder,
// without doing any of it. Rules may be passed in unsaved, so one can be tried
// against a real mailbox before it is trusted with one.
func (a *App) rulesPreview(payload map[string]any) (any, error) {
	accountID, _ := payload["account_id"].(string)
	folder, _ := payload["folder"].(string)
	if accountID == "" {
		return nil, errors.New("invalid account")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	params := map[string]any{"account": accountID, "folder": folder}
	if limit, ok := payload["limit"].(float64); ok {
		params["limit"] = int64(limit)
	}
	if list, ok := payload["rules"].([]any); ok {
		params["rules"] = list
	}
	return a.sidecar.Call("rules.preview", params)
}

// rulesLog returns what the rules have actually done.
func (a *App) rulesLog(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"entries": []any{}}, nil
	}
	params := map[string]any{}
	if limit, ok := payload["limit"].(float64); ok {
		params["limit"] = int64(limit)
	}
	return a.sidecar.Call("rules.log", params)
}

// rulesClearLog forgets the record. It is the reader's own, so theirs to clear.
func (a *App) rulesClearLog(map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("rules.clearLog", map[string]any{})
}
