package main

import (
	"fmt"
	"strings"
)

// An account picture is only ever a copy kept on this computer, or nothing
// (#194). When the copy cannot be made through the account route, the address
// it was to come from waits in the core as the picture source and is tried
// again, through the same route, when the app starts and when a proxy setting
// changes. The web view is never given that address.

// withoutRemoteAvatar blanks a picture address that points at the network, so
// a value an earlier version stored after a failed download is never drawn.
func withoutRemoteAvatar(acc Account) Account {
	if isRemoteURL(acc.AvatarURL) {
		acc.AvatarURL = ""
	}
	return acc
}

// settleAvatars gives each account that is waiting for one a local copy of its
// picture. It also settles pictures that earlier versions stored as a remote
// address: they are fetched through the account route, or dropped and kept as
// a source for a later retry.
func (a *App) settleAvatars() {
	if a.sidecar == nil || !a.sidecar.Started() {
		return
	}
	a.avatarSettleMu.Lock()
	defer a.avatarSettleMu.Unlock()

	res, err := a.sidecar.Call("account.pendingAvatars", map[string]any{})
	if err != nil {
		a.logf("avatars: could not list pending pictures: %v", err)
		return
	}
	obj, _ := res.(map[string]any)
	list, _ := obj["accounts"].([]any)
	for _, item := range list {
		row, _ := item.(map[string]any)
		id, _ := row["id"].(string)
		current, _ := row["avatar_url"].(string)
		source, _ := row["avatar_source"].(string)
		if id == "" {
			continue
		}
		if source == "" {
			source = current
		}
		params := map[string]any{"account": id}
		local, err := a.saveAvatar(id, source)
		if err == nil && !isRemoteURL(source) {
			// Nothing to fetch; only the leftover source is cleared.
			params["avatar_source"] = ""
		} else if err == nil {
			params["avatar_url"] = local
			params["avatar_source"] = ""
		} else {
			a.logf("avatars: account=%s picture not fetched yet: %v", id, err)
			params["avatar_source"] = source
			if isRemoteURL(current) {
				params["avatar_url"] = ""
			}
		}
		if _, err := a.sidecar.Call("account.setAvatar", params); err != nil {
			a.logf("avatars: account=%s could not be saved: %v", id, err)
		}
	}
}

// storeAvatar is what a person choosing a picture runs: the picture becomes a
// local copy, or, when a remote one cannot be fetched now, the previous
// picture stays and the address waits for a retry. It reports whether the
// picture is still pending.
func (a *App) storeAvatar(id, requested string) (pending bool, err error) {
	requested = strings.TrimSpace(requested)
	local, saveErr := a.saveAvatar(id, requested)
	params := map[string]any{"account": id}
	if saveErr != nil {
		a.logf("account.setAvatar: account=%s not fetched yet: %v", id, saveErr)
		params["avatar_source"] = requested
		pending = true
	} else {
		params["avatar_url"] = local
		params["avatar_source"] = ""
	}
	if _, err := a.sidecar.Call("account.setAvatar", params); err != nil {
		return false, fmt.Errorf("account.setAvatar: %w", err)
	}
	return pending, nil
}
