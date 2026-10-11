package main

import "testing"

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
