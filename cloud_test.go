package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPickedFileIsDescribedByPathNameAndSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quote.pdf")
	if err := os.WriteFile(path, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := describePickedFile(path)
	if err != nil {
		t.Fatal(err)
	}
	m := got.(map[string]any)
	if m["path"] != path || m["name"] != "quote.pdf" || m["size"] != int64(5) {
		t.Fatalf("%v", m)
	}
	if _, err := describePickedFile(filepath.Join(t.TempDir(), "gone")); err == nil {
		t.Fatal("a missing file is described")
	}
}
