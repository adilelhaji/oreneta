package main

import (
	"errors"
	"os"
	"path/filepath"
)

// errProfileInUse means a profile's window is open in another process.
var errProfileInUse = errors.New("that profile is open; close its window first")

// profileLockName sits in each profile's folder and is held, for as long as
// it runs, by the process that has the profile open (ADR-0038). Deleting a
// profile takes it first, so an open profile is never deleted under itself.
const profileLockName = ".oreneta-running.lock"

// lockProfile takes the lock of a profile's folder, creating the folder.
func lockProfile(id string) (func(), error) {
	dir := profileDir(rootConfigDir(), id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return lockFile(filepath.Join(dir, profileLockName))
}

// heldProfileLock keeps this process's profile lock (and its file) alive.
var heldProfileLock func()
