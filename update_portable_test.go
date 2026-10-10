package main

import (
	"archive/zip"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeZip(t *testing.T, entries map[string][]byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "oreneta-portable.zip")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for name, body := range entries {
		w, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func portableInstall(t *testing.T) (dir, exe string) {
	t.Helper()
	dir = t.TempDir()
	exe = filepath.Join(dir, "oreneta.exe")
	if err := os.WriteFile(exe, []byte("MZ current"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, exe
}

// Whatever goes wrong with the archive, the installed executable stays as it
// was and nothing is left beside it.
func TestReplaceExecutableRefusesABadArchive(t *testing.T) {
	notZip := filepath.Join(t.TempDir(), "broken.zip")
	if err := os.WriteFile(notZip, []byte("not a zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		archive string
		reason  string
	}{
		"not a zip":         {notZip, "cannot be opened"},
		"no executable":     {writeZip(t, map[string][]byte{"README.txt": []byte("hi")}), "not found"},
		"not a Windows exe": {writeZip(t, map[string][]byte{"oreneta.exe": []byte("#!/bin/sh\n")}), "not contain a Windows executable"},
		"empty entry":       {writeZip(t, map[string][]byte{"oreneta.exe": nil}), "not contain a Windows executable"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			dir, exe := portableInstall(t)
			err := replaceExecutableFrom(tc.archive, exe)
			if err == nil || !strings.Contains(err.Error(), tc.reason) {
				t.Fatalf("err = %v, want %q", err, tc.reason)
			}
			if got, _ := os.ReadFile(exe); string(got) != "MZ current" {
				t.Fatalf("installed executable changed: %q", got)
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 1 {
				t.Fatalf("left behind: %v", entries)
			}
		})
	}
}

func TestReplaceExecutableSwapsInTheNewCopy(t *testing.T) {
	dir, exe := portableInstall(t)
	archive := writeZip(t, map[string][]byte{"Oreneta/OREneta.exe": []byte("MZ new")})
	if err := replaceExecutableFrom(archive, exe); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "MZ new" {
		t.Fatalf("executable = %q", got)
	}
	// The running copy is moved aside for the next launch to sweep up.
	if got, _ := os.ReadFile(exe + oldExeSuffix); string(got) != "MZ current" {
		t.Fatalf("previous copy = %q", got)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 2 {
		t.Fatalf("unexpected files: %v", entries)
	}
}

// If the new copy cannot be moved into place, the previous one is put back.
func TestReplaceExecutableRestoresThePreviousCopyWhenTheSwapFails(t *testing.T) {
	dir, exe := portableInstall(t)
	archive := writeZip(t, map[string][]byte{"oreneta.exe": []byte("MZ new")})
	t.Cleanup(func() { renameFile = os.Rename })
	renameFile = func(from, to string) error {
		if to == exe && strings.Contains(filepath.Base(from), ".oreneta-update-") {
			return errors.New("sharing violation")
		}
		return os.Rename(from, to)
	}
	err := replaceExecutableFrom(archive, exe)
	if err == nil || !strings.Contains(err.Error(), "could not move the new executable into place") {
		t.Fatalf("err = %v", err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "MZ current" {
		t.Fatalf("executable = %q, want the previous copy back", got)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("left behind: %v", entries)
	}
}
