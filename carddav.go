package main

// Address books on CardDAV servers. The bridge carries requests through; the
// core finds the books, keeps the password in the keyring and reads the cards.

import "errors"

func (a *App) carddavCall(method string, payload map[string]any, required ...string) (any, error) {
	for _, key := range required {
		if value, _ := payload[key].(string); value == "" {
			return nil, errors.New("missing " + key)
		}
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call(method, payload)
}

func (a *App) carddavDiscover(payload map[string]any) (any, error) {
	return a.carddavCall("carddav.discover", payload, "server")
}

func (a *App) carddavAdd(payload map[string]any) (any, error) {
	return a.carddavCall("carddav.add", payload, "url")
}

func (a *App) carddavSync(payload map[string]any) (any, error) {
	return a.carddavCall("carddav.sync", payload, "id")
}

func (a *App) carddavRemove(payload map[string]any) (any, error) {
	return a.carddavCall("carddav.remove", payload, "id")
}

// carddavList answers with no sources rather than an error while the engine is
// starting: settings asks for these on open.
func (a *App) carddavList(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"sources": []any{}}, nil
	}
	return a.sidecar.Call("carddav.list", map[string]any{})
}
