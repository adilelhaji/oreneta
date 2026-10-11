package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

type restoreFixture struct {
	config, media string
	now           time.Time
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "<missing>"
	}
	return string(data)
}

// newRestoreFixture is a profile in use (store, WAL, an avatar) and a
// checked archive ready beside it (another store, another avatar).
func newRestoreFixture(t *testing.T) restoreFixture {
	root := t.TempDir()
	f := restoreFixture{config: filepath.Join(root, "config"), media: filepath.Join(root, "cache", "attachments"), now: time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)}
	write(t, filepath.Join(f.config, "meron.db"), "old store")
	write(t, filepath.Join(f.config, "meron.db-wal"), "old wal")
	write(t, filepath.Join(f.media, "avatars", "a", "old.png"), "old avatar")
	write(t, filepath.Join(f.media, "INBOX", "cache.pdf"), "cache")
	ready := readyDir(f.config)
	write(t, filepath.Join(ready, "READY.json"), "{}")
	write(t, filepath.Join(ready, "meron.db"), "restored store")
	write(t, filepath.Join(ready, "media", "avatars", "b", "new.png"), "restored avatar")
	write(t, filepath.Join(ready, "media", "wallpapers", "b", "w.png"), "restored wallpaper")
	return f
}

func (f restoreFixture) assertOriginal(t *testing.T) {
	t.Helper()
	if got := read(filepath.Join(f.config, "meron.db")); got != "old store" {
		t.Fatalf("store %q", got)
	}
	if got := read(filepath.Join(f.config, "meron.db-wal")); got != "old wal" {
		t.Fatalf("wal %q", got)
	}
	if got := read(filepath.Join(f.media, "avatars", "a", "old.png")); got != "old avatar" {
		t.Fatalf("avatar %q", got)
	}
	if exists(filepath.Join(f.media, "avatars", "b")) || exists(filepath.Join(f.media, "wallpapers")) {
		t.Fatal("nothing restored is left in place")
	}
	if exists(journalPath(f.config)) {
		t.Fatal("the journal is gone once the previous profile is back")
	}
}

func TestARestoreSwapsInTheCheckedArchiveAndKeepsThePreviousProfileAside(t *testing.T) {
	f := newRestoreFixture(t)
	journal, err := activateRestore(f.config, f.media, f.now)
	if err != nil {
		t.Fatal(err)
	}
	if read(filepath.Join(f.config, "meron.db")) != "restored store" || exists(filepath.Join(f.config, "meron.db-wal")) {
		t.Fatal("the restored store is live, without the old WAL")
	}
	if read(filepath.Join(f.media, "avatars", "b", "new.png")) != "restored avatar" || exists(filepath.Join(f.media, "avatars", "a")) {
		t.Fatal("the restored pictures replace the old ones")
	}
	if read(filepath.Join(f.media, "INBOX", "cache.pdf")) != "cache" {
		t.Fatal("the attachment cache is not touched")
	}
	if read(filepath.Join(f.config, "before-restore-"+journal.Stamp, "meron.db")) != "old store" {
		t.Fatal("the previous store is kept aside")
	}
	status, _ := readRestoreJournal(f.config)
	if status == nil || status.State != restoreActivated {
		t.Fatalf("journal %+v", status)
	}
	if exists(readyDir(f.config)) {
		t.Fatal("the ready copy was used")
	}
	if _, err := activateRestore(f.config, f.media, f.now); err == nil {
		t.Fatal("a second restore waits for the first to be kept or undone")
	}

	if err := keepRestore(f.config); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(f.config, "before-restore-"+journal.Stamp)) || exists(filepath.Join(f.media, ".before-restore-"+journal.Stamp)) {
		t.Fatal("keeping it deletes the previous profile")
	}
	if exists(journalPath(f.config)) || keepRestore(f.config) == nil {
		t.Fatal("nothing left to keep")
	}
}

func TestGoingBackPutsThePreviousProfileBackExactly(t *testing.T) {
	f := newRestoreFixture(t)
	journal, err := activateRestore(f.config, f.media, f.now)
	if err != nil {
		t.Fatal(err)
	}
	if err := rollbackRestore(f.config, journal); err != nil {
		t.Fatal(err)
	}
	f.assertOriginal(t)
	if exists(filepath.Join(f.config, "before-restore-"+journal.Stamp)) {
		t.Fatal("no aside folder is left behind")
	}
}

func TestARestoreCutShortAtAnyStepIsUndoneOnTheNextStart(t *testing.T) {
	steps := len(planRestore(t.TempDir(), t.TempDir(), "x"))
	for done := 0; done <= steps; done++ {
		f := newRestoreFixture(t)
		journal := &restoreJournal{State: restoreSwapping, Stamp: "cut", Moves: planRestore(f.config, f.media, "cut")}
		if err := writeRestoreJournal(f.config, journal); err != nil {
			t.Fatal(err)
		}
		for _, move := range journal.Moves[:done] {
			if err := applyMove(move); err != nil {
				t.Fatal(err)
			}
		}
		// Half of one move: the live copy moved aside, the staged one not yet in.
		if done < steps && journal.Moves[done].Existed {
			if err := moveAside(journal.Moves[done].Live, journal.Moves[done].Previous); err != nil {
				t.Fatal(err)
			}
		}
		recovered, err := recoverInterruptedRestore(f.config)
		if err != nil || !recovered {
			t.Fatalf("after %d moves: recovered=%v err=%v", done, recovered, err)
		}
		f.assertOriginal(t)
	}
}

func TestAFailedSwapPutsThePreviousProfileBack(t *testing.T) {
	f := newRestoreFixture(t)
	// The pictures cannot be moved aside: a file sits where their folder goes.
	write(t, filepath.Join(f.media, ".before-restore-"+f.now.Format("20060102-150405")), "in the way")
	if _, err := activateRestore(f.config, f.media, f.now); err == nil {
		t.Fatal("expected the swap to fail")
	}
	f.assertOriginal(t)
}

func TestNothingIsSwappedWithoutACheckedArchive(t *testing.T) {
	f := newRestoreFixture(t)
	if err := os.Remove(filepath.Join(readyDir(f.config), "READY.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := activateRestore(f.config, f.media, f.now); err == nil {
		t.Fatal("an archive that was not checked is not restored")
	}
	if read(filepath.Join(f.config, "meron.db")) != "old store" || exists(journalPath(f.config)) {
		t.Fatal("nothing changed")
	}
	if recovered, err := recoverInterruptedRestore(f.config); recovered || err != nil {
		t.Fatal("nothing to recover")
	}
}
