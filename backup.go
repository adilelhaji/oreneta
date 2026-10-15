package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// backupFilename is the name offered in the save dialog. Dated so successive
// backups don't silently overwrite each other, and `.json` because the file is
// plain JSON whose envelope stays readable even when the payload is encrypted.
func backupFilename(now time.Time) string {
	return fmt.Sprintf("oreneta-backup-%s.json", now.Format("2006-01-02"))
}

// exportBackup asks the sidecar to serialize accounts, prefs, feeds and
// settings, then writes the document to a user-chosen path via a native save
// dialog. Cached mail is not included — see meron-core's `backup` module.
//
// `include_secrets` requires a passphrase; the core refuses the combination
// otherwise, so no plaintext file can ever carry a password.
func (a *App) exportBackup(payload map[string]any) (any, error) {
	// Validated before the engine check so the guard holds even with no sidecar:
	// a plaintext file carrying passwords must be unreachable by every path.
	includeSecrets, _ := payload["include_secrets"].(bool)
	passphrase, _ := payload["passphrase"].(string)
	if includeSecrets && passphrase == "" {
		return nil, errors.New("a passphrase is required to include account passwords")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}

	res, err := a.sidecar.Call("backup.export", map[string]any{
		"include_secrets": includeSecrets,
		"passphrase":      passphrase,
		// The sidecar can't know the product version, so the envelope's
		// app_version is only meaningful if the host supplies it. The platform
		// goes with it because desktop and mobile are versioned on separate
		// tracks: "0.2.4" is a different build depending on which wrote it.
		"platform":    "desktop",
		"app_version": appVersion(),
	})
	if err != nil {
		return nil, err
	}
	resMap, _ := res.(map[string]any)
	document, _ := resMap["backup"].(string)
	if document == "" {
		return nil, errors.New("nothing to back up")
	}

	dest, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:                "Export backup",
		DefaultFilename:      backupFilename(time.Now()),
		CanCreateDirectories: true,
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "Oreneta backup (*.json)", Pattern: "*.json"},
		},
	})
	if err != nil {
		return nil, err
	}
	if dest == "" {
		return map[string]any{"saved": false}, nil // user cancelled
	}
	if err := writePrivateFile(dest, []byte(document)); err != nil {
		return nil, fmt.Errorf("write backup: %w", err)
	}
	a.logf("backup.export: wrote %s (secrets=%t)", dest, includeSecrets)
	return map[string]any{"saved": true, "path": dest, "encrypted": passphrase != ""}, nil
}

// importBackup reads a backup file and hands it to the sidecar, which restores
// accounts, feeds and settings.
//
// An encrypted file needs a passphrase the user has not typed yet, so the first
// call comes back `needsPassphrase` along with the chosen `path`. The frontend
// prompts and calls again with that path, which skips the file dialog rather
// than making the user pick the same file twice.
func (a *App) importBackup(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	passphrase, _ := payload["passphrase"].(string)

	src, _ := payload["path"].(string)
	if src == "" {
		chosen, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
			Title: "Restore backup",
			Filters: []wailsRuntime.FileFilter{
				{DisplayName: "Oreneta backup (*.json)", Pattern: "*.json"},
			},
		})
		if err != nil {
			return nil, err
		}
		if chosen == "" {
			return map[string]any{"cancelled": true}, nil // user cancelled
		}
		src = chosen
	}

	data, err := os.ReadFile(src)
	if err != nil {
		return nil, fmt.Errorf("read backup: %w", err)
	}

	res, err := a.sidecar.Call("backup.import", map[string]any{
		"backup":     string(data),
		"passphrase": passphrase,
	})
	if err != nil {
		return nil, err
	}
	resMap, _ := res.(map[string]any)
	if needs, _ := resMap["needs_passphrase"].(bool); needs {
		a.logf("backup.import: %s is encrypted, asking for a passphrase", src)
		return map[string]any{"needsPassphrase": true, "path": src}, nil
	}

	summary := map[string]any{
		"accounts":         jsonInt(resMap["accounts"]),
		"skipped":          jsonInt(resMap["skipped"]),
		"feeds":            jsonInt(resMap["feeds"]),
		"settings":         jsonInt(resMap["settings"]),
		"secrets":          jsonInt(resMap["secrets"]),
		"pgp_keys":         jsonInt(resMap["pgp_keys"]),
		"smime_identities": jsonInt(resMap["smime_identities"]),
	}
	a.logf("backup.import: restored %d accounts (%d skipped), %d feeds, %d settings, %d PGP keys, %d S/MIME identities from %s",
		summary["accounts"], summary["skipped"], summary["feeds"], summary["settings"],
		summary["pgp_keys"], summary["smime_identities"], src)
	// A backup from before pictures were kept as local copies may hold a
	// remote address as an account picture (#194).
	a.requestAvatarSettle(0)
	return summary, nil
}

// jsonInt reads a JSON number (which decodes as float64) as an int.
func jsonInt(value any) int {
	n, _ := value.(float64)
	return int(n)
}

// writePrivateFile replaces path with data, owner-only and all at once.
//
// 0600 matters here: even a backup without secrets lists every address the user
// reads mail for, and an encrypted one is only as private as its passphrase.
// The data goes to a new file beside the target (os.CreateTemp creates it 0600,
// which a umask can only tighten), is flushed to disk, and only then renamed
// over the target. The rename is what replaces the previous file, so an
// interruption, a full disk or a failed write leaves the previous backup as it
// was instead of deleted or half-written, and an existing world-readable file
// never keeps its mode because it is never written to.
func writePrivateFile(path string, data []byte) error {
	dir, name := filepath.Split(path)
	if dir == "" {
		dir = "."
	}
	temp, err := os.CreateTemp(dir, "."+name+".tmp-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := syncFile(temp); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	committed = true
	return nil
}

// syncFile is (*os.File).Sync, replaceable in tests to fail a write late.
var syncFile = (*os.File).Sync

// profileArchiveFilename is offered in the save dialog for a full-profile
// archive (ADR-0017): dated, so successive archives do not replace each other.
func profileArchiveFilename(now time.Time) string {
	return fmt.Sprintf("oreneta-profile-%s.oreneta-profile", now.Format("2006-01-02"))
}

// exportProfileArchive writes the whole profile — store, drafts, local mail,
// chosen pictures — to one encrypted file the person picks. The core writes
// it straight to that path; nothing passes through the JSON bridge but the
// passphrase.
func (a *App) exportProfileArchive(payload map[string]any) (any, error) {
	passphrase, _ := payload["passphrase"].(string)
	if len([]rune(passphrase)) < 8 {
		return nil, errors.New("the passphrase needs at least 8 characters")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	dest, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:                "Back up the whole profile",
		DefaultFilename:      profileArchiveFilename(time.Now()),
		CanCreateDirectories: true,
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "Oreneta profile (*.oreneta-profile)", Pattern: "*.oreneta-profile"},
		},
	})
	if err != nil {
		return nil, err
	}
	if dest == "" {
		return map[string]any{"saved": false}, nil // user cancelled
	}
	res, err := a.sidecar.Call("profileArchive.export", map[string]any{
		"path":        dest,
		"passphrase":  passphrase,
		"app_version": appVersion(),
	})
	if err != nil {
		return nil, err
	}
	a.logf("profileArchive.export: wrote %s", dest)
	out, _ := res.(map[string]any)
	if out == nil {
		out = map[string]any{}
	}
	out["path"] = dest
	return out, nil
}

// inspectProfileArchive opens an archive in a private folder and checks it
// whole, without touching the profile in use. The first call picks the file
// and comes back asking for its passphrase.
func (a *App) inspectProfileArchive(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	src, _ := payload["path"].(string)
	if src == "" {
		chosen, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
			Title: "Check a profile archive",
			Filters: []wailsRuntime.FileFilter{
				{DisplayName: "Oreneta profile (*.oreneta-profile)", Pattern: "*.oreneta-profile"},
			},
		})
		if err != nil {
			return nil, err
		}
		if chosen == "" {
			return map[string]any{"cancelled": true}, nil
		}
		return map[string]any{"needsPassphrase": true, "path": chosen}, nil
	}
	passphrase, _ := payload["passphrase"].(string)
	res, err := a.sidecar.Call("profileArchive.inspect", map[string]any{"path": src, "passphrase": passphrase})
	if err != nil {
		return nil, err
	}
	out, _ := res.(map[string]any)
	if out == nil {
		out = map[string]any{}
	}
	out["path"] = src
	return out, nil
}

// backupPickFolder asks where scheduled backups go (#173). The core checks
// the folder again when the schedule is saved.
func (a *App) backupPickFolder() (any, error) {
	dir, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title:                "Folder for scheduled backups",
		CanCreateDirectories: true,
	})
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return map[string]any{"cancelled": true}, nil
	}
	return map[string]any{"path": dir}, nil
}
