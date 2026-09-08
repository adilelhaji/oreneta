package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
)

func TestFilePickerDefaultDirKeepsExistingCandidate(t *testing.T) {
	isolateTestProfile(t)
	candidate := t.TempDir()

	expected, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		expected = candidate
	}

	if got := filePickerDefaultDir(candidate); got != expected {
		t.Fatalf("filePickerDefaultDir(%q) = %q, want %q", candidate, got, expected)
	}
}

func TestFilePickerDefaultDirFallsBackToHome(t *testing.T) {
	home := isolateTestProfile(t).Home
	missing := filepath.Join(home, "Downloads")

	expected, err := filepath.EvalSymlinks(home)
	if err != nil {
		expected = home
	}

	if got := filePickerDefaultDir(missing); got != expected {
		t.Fatalf("filePickerDefaultDir(%q) = %q, want %q", missing, got, expected)
	}
}

func TestFilePickerDefaultDirResolvesSymlink(t *testing.T) {
	home := isolateTestProfile(t).Home
	target := t.TempDir()
	link := filepath.Join(home, "Downloads")
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" && errors.Is(err, syscall.Errno(1314)) {
			t.Skip("Windows symlink privilege unavailable")
		}
		t.Fatalf("create symlink: %v", err)
	}

	expected, err := filepath.EvalSymlinks(target)
	if err != nil {
		expected = target
	}

	if got := filePickerDefaultDir(link); got != expected {
		t.Fatalf("filePickerDefaultDir(%q) = %q, want %q", link, got, expected)
	}
}
