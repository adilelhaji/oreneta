package main

// Activating a restored profile (#172, ADR-0010, ADR-0017). The core has
// already unpacked, checked and re-keyed the archive into
// restore-staging/ready; this swaps it in with the core stopped.
//
// Every move is written to a journal before it is made. If the swap fails,
// or the app stops half way, the journal puts the previous profile back. Once
// active, the previous profile is kept beside it until the person keeps the
// restored one or goes back to the old one.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	restoreJournalFile = "restore-journal.json"
	restoreSwapping    = "swapping"
	restoreActivated   = "activated"
)

type restoreMove struct {
	Live     string `json:"live"`
	Staged   string `json:"staged"`
	Previous string `json:"previous"`
	// Whether something was at Live before the swap: only then is there a
	// previous copy to put back.
	Existed bool `json:"existed"`
}

type restoreJournal struct {
	State string        `json:"state"`
	Stamp string        `json:"stamp"`
	Moves []restoreMove `json:"moves"`
}

func readyDir(configDir string) string {
	return filepath.Join(configDir, "restore-staging", "ready")
}

func journalPath(configDir string) string {
	return filepath.Join(configDir, restoreJournalFile)
}

func readRestoreJournal(configDir string) (*restoreJournal, error) {
	data, err := os.ReadFile(journalPath(configDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var journal restoreJournal
	if err := json.Unmarshal(data, &journal); err != nil {
		return nil, fmt.Errorf("the restore journal is damaged: %w", err)
	}
	return &journal, nil
}

func writeRestoreJournal(configDir string, journal *restoreJournal) error {
	data, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return err
	}
	return writePrivateFile(journalPath(configDir), data)
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// moveAside renames, or copies and removes where a rename cannot cross
// volumes (the config and cache folders may be on different ones).
func moveAside(from, to string) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
		return err
	}
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	if err := copyTree(from, to); err != nil {
		_ = os.RemoveAll(to)
		return err
	}
	return os.RemoveAll(from)
}

func copyTree(from, to string) error {
	return filepath.WalkDir(from, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		target := filepath.Join(to, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	})
}

// planRestore lists the moves: the store and its journal files, and the
// two media folders a person fills.
func planRestore(configDir, mediaRoot, stamp string) []restoreMove {
	ready := readyDir(configDir)
	aside := filepath.Join(configDir, "before-restore-"+stamp)
	mediaAside := filepath.Join(mediaRoot, ".before-restore-"+stamp)
	moves := []restoreMove{}
	for _, name := range []string{"meron.db", "meron.db-wal", "meron.db-shm"} {
		staged := ""
		if name == "meron.db" {
			staged = filepath.Join(ready, "meron.db")
		}
		live := filepath.Join(configDir, name)
		moves = append(moves, restoreMove{Live: live, Staged: staged, Previous: filepath.Join(aside, name), Existed: exists(live)})
	}
	for _, folder := range []string{"avatars", "wallpapers"} {
		live := filepath.Join(mediaRoot, folder)
		moves = append(moves, restoreMove{
			Live:     live,
			Staged:   filepath.Join(ready, "media", folder),
			Previous: filepath.Join(mediaAside, folder),
			Existed:  exists(live),
		})
	}
	return moves
}

// activateRestore swaps the ready profile in. The core must be stopped.
func activateRestore(configDir, mediaRoot string, now time.Time) (*restoreJournal, error) {
	if journal, err := readRestoreJournal(configDir); err != nil || journal != nil {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("a restore is already active; keep it or go back first")
	}
	ready := readyDir(configDir)
	if !exists(filepath.Join(ready, "READY.json")) || !exists(filepath.Join(ready, "meron.db")) {
		return nil, errors.New("no checked archive is ready to restore")
	}
	journal := &restoreJournal{State: restoreSwapping, Stamp: now.Format("20060102-150405"), Moves: planRestore(configDir, mediaRoot, now.Format("20060102-150405"))}
	if err := writeRestoreJournal(configDir, journal); err != nil {
		return nil, err
	}
	for _, move := range journal.Moves {
		if err := applyMove(move); err != nil {
			rollbackErr := rollbackRestore(configDir, journal)
			if rollbackErr != nil {
				return nil, fmt.Errorf("restore failed (%v) and the previous profile could not be put back: %w", err, rollbackErr)
			}
			return nil, fmt.Errorf("restore failed; the previous profile is back: %w", err)
		}
	}
	journal.State = restoreActivated
	if err := writeRestoreJournal(configDir, journal); err != nil {
		_ = rollbackRestore(configDir, journal)
		return nil, err
	}
	_ = os.RemoveAll(ready)
	return journal, nil
}

func applyMove(move restoreMove) error {
	if move.Existed {
		if err := moveAside(move.Live, move.Previous); err != nil {
			return err
		}
	}
	if move.Staged != "" && exists(move.Staged) {
		return moveAside(move.Staged, move.Live)
	}
	return nil
}

// rollbackRestore puts the previous profile back from whatever point the
// swap reached, then forgets the journal. Safe to run more than once.
func rollbackRestore(configDir string, journal *restoreJournal) error {
	for i := len(journal.Moves) - 1; i >= 0; i-- {
		move := journal.Moves[i]
		if move.Existed {
			if !exists(move.Previous) {
				continue // never moved aside: what is live is the original
			}
			if err := os.RemoveAll(move.Live); err != nil {
				return err
			}
			if err := moveAside(move.Previous, move.Live); err != nil {
				return err
			}
		} else if err := os.RemoveAll(move.Live); err != nil {
			return err
		}
	}
	forgetAsideFolders(journal)
	return os.Remove(journalPath(configDir))
}

func forgetAsideFolders(journal *restoreJournal) {
	for _, move := range journal.Moves {
		_ = os.RemoveAll(move.Previous)
		_ = os.Remove(filepath.Dir(move.Previous))
	}
}

// keepRestore makes an activated restore final: the previous profile kept
// aside is deleted.
func keepRestore(configDir string) error {
	journal, err := readRestoreJournal(configDir)
	if err != nil {
		return err
	}
	if journal == nil || journal.State != restoreActivated {
		return errors.New("there is no restore to keep")
	}
	forgetAsideFolders(journal)
	return os.Remove(journalPath(configDir))
}

// recoverInterruptedRestore runs before the core starts: a swap cut short
// is rolled back, so the app never opens half of each profile.
func recoverInterruptedRestore(configDir string) (bool, error) {
	journal, err := readRestoreJournal(configDir)
	if err != nil || journal == nil || journal.State != restoreSwapping {
		return false, err
	}
	return true, rollbackRestore(configDir, journal)
}

// ---- Bridge commands --------------------------------------------------------

func (a *App) prepareProfileRestore(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	src, _ := payload["path"].(string)
	if src == "" {
		chosen, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
			Title: "Restore a profile archive",
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
	res, err := a.sidecar.Call("profileArchive.stage", map[string]any{"path": src, "passphrase": passphrase})
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

// withCoreStopped runs `swap` with the core stopped and starts it again. If
// the core does not come back, `undo` runs and the core is started on what
// it put back.
func (a *App) withCoreStopped(swap func() error, undo func() error) error {
	if a.sidecar == nil {
		return a.engineUnavailable()
	}
	if err := a.sidecar.Stop(15 * time.Second); err != nil {
		_ = a.sidecar.Restart(a.ctx, 15*time.Second)
		return err
	}
	if err := swap(); err != nil {
		_ = a.sidecar.Restart(a.ctx, 15*time.Second)
		return err
	}
	if err := a.sidecar.Restart(a.ctx, 15*time.Second); err == nil {
		if _, err = a.sidecar.Call("account.list", nil); err == nil {
			return nil
		}
	}
	a.logf("restore: the core did not open the swapped profile; putting the previous one back")
	_ = a.sidecar.Stop(15 * time.Second)
	if err := undo(); err != nil {
		return fmt.Errorf("the core did not open the restored profile, and going back failed: %w", err)
	}
	_ = a.sidecar.Restart(a.ctx, 15*time.Second)
	return errors.New("the core did not open the restored profile; the previous one is back")
}

func (a *App) activateProfileRestore() (any, error) {
	configDir := appConfigDir()
	var journal *restoreJournal
	err := a.withCoreStopped(func() error {
		var err error
		journal, err = activateRestore(configDir, mediaDir(), time.Now())
		return err
	}, func() error {
		if journal == nil {
			return nil
		}
		return rollbackRestore(configDir, journal)
	})
	if err != nil {
		return nil, err
	}
	a.logf("restore: activated a profile archive (previous kept as before-restore-%s)", journal.Stamp)
	return map[string]any{"activated": true}, nil
}

func (a *App) undoProfileRestore() (any, error) {
	configDir := appConfigDir()
	journal, err := readRestoreJournal(configDir)
	if err != nil {
		return nil, err
	}
	if journal == nil || journal.State != restoreActivated {
		return nil, errors.New("there is no restore to go back from")
	}
	err = a.withCoreStopped(func() error { return rollbackRestore(configDir, journal) }, func() error { return nil })
	if err != nil {
		return nil, err
	}
	return map[string]any{"restored": false}, nil
}

func (a *App) profileRestoreStatus() (any, error) {
	journal, err := readRestoreJournal(appConfigDir())
	if err != nil {
		return nil, err
	}
	if journal == nil {
		return map[string]any{"state": "none"}, nil
	}
	return map[string]any{"state": journal.State, "stamp": journal.Stamp}, nil
}
