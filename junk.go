package main

// Junk: filing a conversation where the account keeps unwanted mail, and
// taking it back out again.
//
// A move, not a flag. On Gmail and Exchange the junk folder is what teaches
// the server's own filter, so moving there does the thing a reader means by
// "this is spam" — on a plain IMAP server it files it and nothing more, which
// is all that server offers.

import "errors"

// mailMarkJunk moves a conversation into the account's junk folder, or back to
// the inbox when `junk` is false.
func (a *App) mailMarkJunk(payload map[string]any) (any, error) {
	threadID, _ := payload["thread_id"].(string)
	if threadID == "" {
		return nil, errors.New("invalid thread")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	if _, _, ok := parseRSSThreadID(threadID); ok {
		return nil, errors.New("feed items cannot be marked as junk")
	}
	ids, ok := parseImapThreadID(threadID)
	if !ok {
		return map[string]any{"ok": true}, nil
	}

	// Into junk, or back to where mail arrives. "Not junk" has to name a
	// destination too: a message taken out of junk has to go somewhere, and
	// the inbox is the only place a reader means.
	junk := true
	if value, present := payload["junk"].(bool); present {
		junk = value
	}
	role := "junk"
	if !junk {
		role = "inbox"
	}

	res, err := a.sidecar.Call("folders.byRole", map[string]any{"account": ids.Account, "role": role})
	if err != nil {
		return nil, err
	}
	obj, _ := res.(map[string]any)
	target, _ := obj["folder"].(string)
	if target == "" {
		// Said as itself. An account with no junk folder is not a failed
		// move; it is an account that cannot do this at all, and the reader
		// should be told which.
		if junk {
			return nil, errors.New("This account has no junk folder")
		}
		return nil, errors.New("This account has no inbox to move it back to")
	}

	payload["target_folder_id"] = target
	return a.mailMove(payload)
}
