package main

// People, from whichever address books have been brought in. The bridge only
// carries them through; the core owns the books and what is in them.

// peopleList returns the address book, filtered by `query` when there is one.
//
// An engine that has not started answers with nobody rather than an error: the
// Personas view asks for these while the app is opening, and a screen that
// failed to load is a worse answer than one that is briefly empty.
func (a *App) peopleList(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"people": []any{}}, nil
	}
	query, _ := payload["query"].(string)
	params := map[string]any{"query": query}
	if limit, ok := payload["limit"]; ok {
		params["limit"] = limit
	}
	return a.sidecar.Call("people.list", params)
}
