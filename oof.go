package main

import "errors"

// Out-of-office / Automatic Replies. What shape the settings take, and
// whether they live on the server or are this app's own preference, is
// decided core-side from the account's own protocol — see oof.get/oof.set
// in meron-core/src/main.rs.

func (a *App) oofGet(payload map[string]any) (any, error) {
	account, _ := payload["account"].(string)
	if account == "" {
		return nil, errors.New("no account given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("oof.get", map[string]any{"account": account})
}

func (a *App) oofSet(payload map[string]any) (any, error) {
	account, _ := payload["account"].(string)
	if account == "" {
		return nil, errors.New("no account given")
	}
	if _, ok := payload["settings"]; !ok {
		return nil, errors.New("no settings given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("oof.set", payload)
}
