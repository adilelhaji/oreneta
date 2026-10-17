package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestJSONHelpersCoerceExpectedTypes(t *testing.T) {
	if got := jsonString("value"); got != "value" {
		t.Fatalf("jsonString string = %q", got)
	}
	if got := jsonString(12); got != "" {
		t.Fatalf("jsonString non-string = %q, want empty", got)
	}

	if got := jsonBool(true); got != true {
		t.Fatalf("jsonBool true = %v", got)
	}
	if got := jsonBool("true"); got != false {
		t.Fatalf("jsonBool non-bool = %v, want false", got)
	}

	tests := []struct {
		value any
		want  int64
	}{
		{float64(42.9), 42},
		{json.Number("43"), 43},
		{int64(44), 44},
		{"45", 0},
		{json.Number("not-a-number"), 0},
	}
	for _, tt := range tests {
		if got := jsonNumber(tt.value); got != tt.want {
			t.Fatalf("jsonNumber(%#v) = %d, want %d", tt.value, got, tt.want)
		}
	}
}

// The App Store build ships the sidecar at Oreneta.app/Contents/MacOS/oreneta-core
// and relies on this lookup to find it: the sandbox forbids exec'ing the copy
// the other builds extract to the cache dir.
func TestBundledSidecarPathIn(t *testing.T) {
	dir := t.TempDir()
	if got := bundledSidecarPathIn(dir); got != "" {
		t.Fatalf("empty dir = %q, want no sidecar", got)
	}

	// A directory of that name is not a sidecar.
	path := filepath.Join(dir, sidecarBinaryName)
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := bundledSidecarPathIn(dir); got != "" {
		t.Fatalf("directory = %q, want no sidecar", got)
	}

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := bundledSidecarPathIn(dir); got != path {
		t.Fatalf("bundledSidecarPathIn = %q, want %q", got, path)
	}

	// Meron's name beside the executable is not this app's sidecar.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "meron-core"+sidecarExeSuffix), nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := bundledSidecarPathIn(dir); got != "" {
		t.Fatalf("meron-core beside the executable = %q, want no sidecar", got)
	}
}

// The engine runs as oreneta-core wherever it comes from, so Task Manager and
// Activity Monitor show the app's name (#247); only the crate directory keeps
// Meron's.
func TestSidecarBinaryIsNamedAfterOreneta(t *testing.T) {
	want := "oreneta-core"
	if runtime.GOOS == "windows" {
		want += ".exe"
	}
	if sidecarBinaryName != want {
		t.Fatalf("sidecarBinaryName = %q, want %q", sidecarBinaryName, want)
	}
	if got, wantPath := debugSidecarPath(), filepath.Join("meron-core", "target", "debug", want); got != wantPath {
		t.Fatalf("debugSidecarPath = %q, want %q", got, wantPath)
	}

	name := extractedSidecarName([]byte("engine"))
	hash := strings.TrimSuffix(strings.TrimPrefix(name, "oreneta-core-"), sidecarExeSuffix)
	if !strings.HasPrefix(name, "oreneta-core-") || !strings.HasSuffix(name, sidecarExeSuffix) || len(hash) != 16 {
		t.Fatalf("extractedSidecarName = %q, want oreneta-core-<16 hex>%s", name, sidecarExeSuffix)
	}
	if extractedSidecarName([]byte("engine")) != name {
		t.Fatal("the same build must extract to the same file")
	}
	if extractedSidecarName([]byte("another build")) == name {
		t.Fatal("a new build must extract to a new file")
	}
}

func TestSidecarErrorMessage(t *testing.T) {
	if got := sidecarErrorMessage(map[string]any{"message": "bad credentials"}); got != "bad credentials" {
		t.Fatalf("sidecarErrorMessage message = %q", got)
	}
	if got := sidecarErrorMessage(map[string]any{"code": "NO"}); got != `{"code":"NO"}` {
		t.Fatalf("sidecarErrorMessage map = %q", got)
	}
	if got := sidecarErrorMessage("plain"); got != "plain" {
		t.Fatalf("sidecarErrorMessage string = %q", got)
	}
	if got := sidecarErrorMessage(12); got != "12" {
		t.Fatalf("sidecarErrorMessage int = %q", got)
	}
}

func TestSidecarCallTimeouts(t *testing.T) {
	tests := map[string]time.Duration{
		"account.connect":     45 * time.Second,
		"messages.thread":     30 * time.Second,
		"messages.markRead":   30 * time.Second,
		"folders.list":        15 * time.Second,
		"folders.delete":      30 * time.Second,
		"rss.importOpml":      15 * time.Second,
		"backup.export":       30 * time.Second,
		"backup.import":       30 * time.Second,
		"unknown.sidecarCall": 5 * time.Second,
		// Streaming whole folders or profiles is bounded by the data, not a fixed budget.
		"messages.exportMbox":   2 * time.Hour,
		"archive.import":        2 * time.Hour,
		"profileArchive.export": 2 * time.Hour,
		"profileArchive.stage":  2 * time.Hour,
		// Task lists on a CalDAV server (ADR-0039).
		"tasks.caldavDiscover":  60 * time.Second,
		"tasks.caldavAdd":       60 * time.Second,
		"tasks.exchangeAdd":     60 * time.Second,
		"tasks.resolveConflict": 60 * time.Second,
		"tasks.sync":            5 * time.Minute,
		// Exchange contacts and distribution lists (ADR-0058).
		"exchange.contacts.sync": 2 * time.Minute,
		"people.groupSave":       60 * time.Second,
		"people.groupDelete":     60 * time.Second,
		// Exchange contact folders and people (ADR-0064).
		"carddav.sync":  2 * time.Minute,
		"people.save":   60 * time.Second,
		"people.delete": 60 * time.Second,
		// Automatic archiving (ADR-0054): a preview searches the chosen
		// folders; a run copies or moves every old message.
		"autoArchive.preview": 10 * time.Minute,
		"autoArchive.runNow":  2 * time.Hour,
		"autoArchive.status":  5 * time.Second,
	}
	for method, want := range tests {
		if got := sidecarCallTimeout(method); got != want {
			t.Fatalf("sidecarCallTimeout(%q) = %s, want %s", method, got, want)
		}
	}
}

func TestFileExists(t *testing.T) {
	if fileExists("") {
		t.Fatal("fileExists(\"\") = true")
	}
	path := t.TempDir() + "/file.txt"
	if fileExists(path) {
		t.Fatal("fileExists before create = true")
	}
	if err := os.WriteFile(path, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if !fileExists(path) {
		t.Fatal("fileExists after create = false")
	}
}
