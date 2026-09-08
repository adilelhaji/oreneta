package main

// The learned spam filter: why a conversation is flagged, and recording what
// the reader says about one without moving it. Marking (or unmarking) junk
// already teaches it — see junk.go — this is the other way in, for the
// reader who dismisses the suggestion without moving anything.

import "errors"

// mailSpamReason reports why a conversation looks like spam, or why it
// doesn't, from what the reader has taught this account so far.
func (a *App) mailSpamReason(payload map[string]any) (any, error) {
	threadID, _ := payload["thread_id"].(string)
	if threadID == "" {
		return nil, errors.New("invalid thread")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("mail.spamReason", map[string]any{"thread_id": threadID})
}

// mailRecordSpamJudgment records what the reader said about a conversation —
// spam confirmed, or not spam — without moving it anywhere. Used when the
// reader dismisses a spam suggestion in place; marking or unmarking junk
// records the same judgment as part of the move instead.
func (a *App) mailRecordSpamJudgment(payload map[string]any) (any, error) {
	threadID, _ := payload["thread_id"].(string)
	if threadID == "" {
		return nil, errors.New("invalid thread")
	}
	spam, ok := payload["spam"].(bool)
	if !ok {
		return nil, errors.New("missing spam")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("mail.recordSpamJudgment", map[string]any{"thread_id": threadID, "spam": spam})
}
