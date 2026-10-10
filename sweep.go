package main

// Sweep, and the reasons behind the priority inbox.
//
// Both are asked before they act: a sweep shows what it would move, and a
// priority verdict shows what it was based on. Neither is a thing to do
// quietly on someone's mailbox.

import "errors"

// mailSweepPreview reports what a sweep would move, moving nothing.
func (a *App) mailSweepPreview(payload map[string]any) (any, error) {
	accountID, _ := payload["account_id"].(string)
	from, _ := payload["from"].(string)
	if accountID == "" || from == "" {
		return nil, errors.New("invalid sweep")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	folder, _ := payload["folder"].(string)
	params := map[string]any{"account": accountID, "folder": folder, "from": from}
	if keep, ok := payload["keep_newest"].(float64); ok {
		params["keep_newest"] = int64(keep)
	}
	return a.sidecar.Call("mail.sweepPreview", params)
}

// mailSweep does the sweep the reader was shown and agreed to.
//
// The preview the core handed out is what is confirmed, by its review id: the
// core moves exactly the messages it listed, once, and only while the folder
// is still the one they were listed in. Mail that arrived since the preview
// is not touched, and a second confirmation of the same preview is refused
// rather than repeated. The answer says item by item what went.
func (a *App) mailSweep(payload map[string]any) (any, error) {
	accountID, _ := payload["account_id"].(string)
	reviewID, _ := payload["review_id"].(string)
	if accountID == "" || reviewID == "" {
		return nil, errors.New("invalid sweep: confirm a preview, not a sender")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("mail.sweepExecute", map[string]any{
		"account":   accountID,
		"review_id": reviewID,
	})
}

// mailPriorityReason reports why a conversation is where it is.
func (a *App) mailPriorityReason(payload map[string]any) (any, error) {
	threadID, _ := payload["thread_id"].(string)
	if threadID == "" {
		return nil, errors.New("invalid thread")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("mail.priorityReason", map[string]any{"thread_id": threadID})
}

// mailSetSenderPriority records what the reader decided about a sender.
// Omitting `priority` forgets the decision rather than reversing it.
func (a *App) mailSetSenderPriority(payload map[string]any) (any, error) {
	accountID, _ := payload["account_id"].(string)
	addr, _ := payload["addr"].(string)
	if accountID == "" || addr == "" {
		return nil, errors.New("invalid sender")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	params := map[string]any{"account": accountID, "addr": addr}
	if choice, ok := payload["priority"].(bool); ok {
		params["priority"] = choice
	}
	return a.sidecar.Call("mail.setSenderPriority", params)
}
