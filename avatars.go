package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// An account picture is only ever a copy kept on this computer, or nothing
// (#194). When the copy cannot be made through the account route, the address
// it was to come from waits in the core as the picture source and is tried
// again, through the same route, when the app starts and when a proxy setting
// changes. The web view is never given that address.

// withoutRemoteAvatar blanks a picture address that is not a local copy, so
// a value an earlier version stored after a failed download, or one that came
// in from a backup, is never drawn.
func withoutRemoteAvatar(acc Account) Account {
	if !isLocalAvatar(acc.AvatarURL) {
		acc.AvatarURL = ""
	}
	return acc
}

// avatarSettleDelay is how long a proxy change waits before pictures are
// tried again: the settings save on every keystroke, and a half-typed proxy
// should not be asked for anything.
const avatarSettleDelay = 2 * time.Second

// requestAvatarSettle runs settleAvatars in the background after delay. Any
// number of requests that arrive while one is waiting or running become one
// more run after it, never a queue of them.
func (a *App) requestAvatarSettle(delay time.Duration) {
	a.avatarDirty.Store(true)
	if !a.avatarRunning.CompareAndSwap(false, true) {
		return
	}
	run := a.settleAvatars
	if a.avatarRun != nil {
		run = a.avatarRun
	}
	go func() {
		for {
			time.Sleep(delay)
			for a.avatarDirty.Swap(false) {
				run()
			}
			a.avatarRunning.Store(false)
			// A request that came in between the last check and the store
			// above must not be lost.
			if !a.avatarDirty.Load() || !a.avatarRunning.CompareAndSwap(false, true) {
				return
			}
		}
	}()
}

// settleAvatars gives each account that is waiting for one a local copy of its
// picture. It also settles pictures that earlier versions stored as a remote
// address: they are fetched through the account route, or dropped and kept as
// a source for a later retry.
//
// The core applies each result only while the account still holds the picture
// and source that were read, so a retry that was slow cannot undo what
// somebody chose in the meantime.
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
	stored := false
	for _, item := range list {
		if !a.sidecar.Started() {
			return
		}
		row, _ := item.(map[string]any)
		id, _ := row["id"].(string)
		current, _ := row["avatar_url"].(string)
		waiting, _ := row["avatar_source"].(string)
		if id == "" {
			continue
		}
		source := waiting
		if source == "" {
			source = current
		}

		params := map[string]any{
			"account":              id,
			"expect_avatar_url":    current,
			"expect_avatar_source": waiting,
		}
		local := ""
		if isRemoteURL(source) {
			local, err = a.saveAvatar(id, source)
		} else {
			err = fmt.Errorf("not a picture address")
		}
		switch {
		case err == nil:
			params["avatar_url"] = local
			params["avatar_source"] = ""
		default:
			a.logf("avatars: account=%s picture not fetched yet: %v", id, err)
			keep := ""
			if isRemoteURL(source) {
				keep = source
			}
			// Nothing to change: it was waiting for the same address already.
			if isLocalAvatar(current) && waiting == keep {
				continue
			}
			params["avatar_source"] = keep
			if !isLocalAvatar(current) {
				params["avatar_url"] = ""
			}
		}
		out, err := a.sidecar.Call("account.setAvatar", params)
		if err != nil {
			a.logf("avatars: account=%s could not be saved: %v", id, err)
			discardAvatarCopy(local)
			continue
		}
		applied, _ := out.(map[string]any)["applied"].(bool)
		if !applied {
			// Somebody changed the picture while it was being fetched.
			discardAvatarCopy(local)
		} else if local != "" {
			stored = true
		}
	}
	if stored {
		a.tellPicturesChanged()
	}
}

// discardAvatarCopy removes a copy that was made but not kept.
func discardAvatarCopy(local string) {
	if !strings.HasPrefix(local, "/media/") {
		return
	}
	if path, err := resolveMediaPath(strings.TrimPrefix(local, "/media/")); err == nil {
		_ = os.Remove(filepath.Clean(path))
	}
}

// storeAvatar is what a person choosing a picture runs: the picture becomes a
// local copy, or, when a remote one cannot be fetched now, the previous
// picture stays and the address waits for a retry. It returns the picture now
// stored (a local copy, or "" for none), which the interface shows at once, and
// whether a remote picture is still pending.
func (a *App) storeAvatar(id, requested string) (stored string, pending bool, err error) {
	requested = strings.TrimSpace(requested)
	local, saveErr := a.saveAvatar(id, requested)
	params := map[string]any{"account": id}
	switch {
	case saveErr != nil && isRemoteURL(requested):
		a.logf("account.setAvatar: account=%s not fetched yet: %v", id, saveErr)
		params["avatar_source"] = requested
		pending = true
	case saveErr != nil:
		return "", false, saveErr
	default:
		params["avatar_url"] = local
		params["avatar_source"] = ""
	}
	if _, err := a.sidecar.Call("account.setAvatar", params); err != nil {
		discardAvatarCopy(local)
		return "", false, fmt.Errorf("account.setAvatar: %w", err)
	}
	return local, pending, nil
}

// tellPicturesChanged lets the interface read the pictures again after a retry
// stored a copy.
func (a *App) tellPicturesChanged() {
	if a.ctx != nil {
		wailsRuntime.EventsEmit(a.ctx, "accounts.picturesChanged")
	}
}
