package main

import (
	"testing"
	"time"
)

// A write to the local address book cannot report success without the core:
// nothing would have been saved.
func TestPeopleWriteWithoutEngineFails(t *testing.T) {
	app := &App{}
	for _, method := range []string{"people.save", "people.delete"} {
		if _, err := app.peopleWrite(method, map[string]any{"id": "x"}); err == nil {
			t.Fatalf("%s succeeded with no engine running", method)
		}
	}
}

// Contact groups (ADR-0052): reading them with no core is an empty answer,
// writing them is an error, and a write to a CardDAV book gets the time a
// read-then-write round trip needs.
func TestPeopleGroupsBridge(t *testing.T) {
	app := &App{}
	groups, err := app.peopleRead("people.groups", map[string]any{})
	if err != nil || len(groups.(map[string]any)["groups"].([]any)) != 0 {
		t.Fatalf("people.groups with no engine = %v, %v", groups, err)
	}
	names, err := app.peopleRead("people.names", map[string]any{"addrs": []any{"a@example.com"}})
	if err != nil || len(names.(map[string]any)["names"].(map[string]any)) != 0 {
		t.Fatalf("people.names with no engine = %v, %v", names, err)
	}
	for _, method := range []string{"people.groupSave", "people.groupDelete"} {
		if _, err := app.peopleWrite(method, map[string]any{"name": "x"}); err == nil {
			t.Fatalf("%s succeeded with no engine running", method)
		}
		if sidecarCallTimeout(method) < 30*time.Second {
			t.Fatalf("%s needs time for a CardDAV round trip", method)
		}
	}
}
