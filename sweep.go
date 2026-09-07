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

// mailSweep moves everything the preview named into the account's trash.
//
// It asks for the preview again rather than trusting a list the interface
// carried back: between showing it and agreeing to it, mail may have arrived
// from the same sender, and sweeping a message nobody was shown is the one
// thing this must not do.
func (a *App) mailSweep(payload map[string]any) (any, error) {
	accountID, _ := payload["account_id"].(string)
	if accountID == "" {
		return nil, errors.New("invalid sweep")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}

	preview, err := a.mailSweepPreview(payload)
	if err != nil {
		return nil, err
	}
	object, _ := preview.(map[string]any)
	list, _ := object["messages"].([]any)
	if len(list) == 0 {
		return map[string]any{"ok": true, "swept": 0}, nil
	}
	uids := make([]any, 0, len(list))
	for _, item := range list {
		if entry, ok := item.(map[string]any); ok {
			uids = append(uids, entry["uid"])
		}
	}

	trash, err := a.sidecar.Call("folders.byRole", map[string]any{"account": accountID, "role": "trash"})
	if err != nil {
		return nil, err
	}
	trashObject, _ := trash.(map[string]any)
	target, _ := trashObject["folder"].(string)
	if target == "" {
		return nil, errors.New("This account has no trash folder")
	}

	folder, _ := object["folder"].(string)
	if _, err := a.sidecar.Call("messages.move", map[string]any{
		"account":       accountID,
		"folder":        folder,
		"target_folder": target,
		"uids":          uids,
	}); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "swept": len(uids), "folder": target}, nil
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
