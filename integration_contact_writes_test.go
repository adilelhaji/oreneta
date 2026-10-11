//go:build integration

package main

import (
	"strings"
	"testing"
)

// Writing contacts back to a real CardDAV server (ADR-0012): an edit is
// written from the version it was read at and keeps fields the app does not
// show; a change made on the server meanwhile is a conflict that writes
// nothing; a new contact and a delete go through with their conditions.
// Radicale in Docker stands in for a server; no provider is certified.
func TestIntegrationContactWrites(t *testing.T) {
	server := startRadicale(t)
	sidecar, _ := startSidecar(t)
	server.createAddressBook(t, "contacts", "Team contacts")

	cardURL := server.bookURL("contacts") + "itest-ada.vcf"
	ada := "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:itest-ada\r\nFN:Ada Lovelace\r\nN:Lovelace;Ada;;;\r\n" +
		"EMAIL:ada@example.test\r\nBDAY:1815-12-10\r\nADR;TYPE=HOME:;;12 St James's Square;London;;;UK\r\nEND:VCARD\r\n"
	if status, reply := server.dav(t, "PUT", cardURL, ada, map[string]string{"Content-Type": "text/vcard"}); status != 201 {
		t.Fatalf("seed PUT: HTTP %d %s", status, reply)
	}
	added := callMap(t, sidecar, "carddav.add", map[string]any{
		"url": server.bookURL("contacts"), "name": "Team contacts", "username": radicaleUser, "password": testPassword,
	})
	if added["synced"] != true {
		t.Fatalf("first sync: %v", added)
	}
	sourceID := str(added, "id")

	findAda := func() map[string]any {
		rows, _ := callMap(t, sidecar, "people.list", map[string]any{"query": "Ada"})["people"].([]any)
		if len(rows) != 1 {
			t.Fatalf("people.list = %v", rows)
		}
		return rows[0].(map[string]any)
	}

	person := findAda()
	if person["editable"] != true || str(person, "version") == "" {
		t.Fatalf("a writable CardDAV contact should be editable with its version: %v", person)
	}

	t.Run("an edit keeps the fields the app does not show", func(t *testing.T) {
		result := callMap(t, sidecar, "people.save", map[string]any{
			"id": str(person, "id"), "version": str(person, "version"),
			"person": map[string]any{"name": "Ada Lovelace", "note": "Analytical Engine", "emails": []any{map[string]any{"addr": "ada@example.test"}}},
		})
		if result["ok"] != true {
			t.Fatalf("save: %v", result)
		}
		_, card := server.dav(t, "GET", cardURL, "", nil)
		for _, want := range []string{"NOTE:Analytical Engine", "BDAY:1815-12-10", "12 St James", "UID:itest-ada"} {
			if !strings.Contains(card, want) {
				t.Fatalf("server card lost %q:\n%s", want, card)
			}
		}
		if findAda()["version"] == person["version"] {
			t.Fatalf("the local copy should carry the new version")
		}
	})

	t.Run("a change made elsewhere is a conflict that writes nothing", func(t *testing.T) {
		stale := findAda()
		_, card := server.dav(t, "GET", cardURL, "", nil)
		elsewhere := strings.Replace(card, "FN:Ada Lovelace", "FN:Augusta Ada King", 1)
		if status, reply := server.dav(t, "PUT", cardURL, elsewhere, map[string]string{"Content-Type": "text/vcard"}); status >= 300 {
			t.Fatalf("change on the server: HTTP %d %s", status, reply)
		}
		result := callMap(t, sidecar, "people.save", map[string]any{
			"id": str(stale, "id"), "version": str(stale, "version"),
			"person": map[string]any{"name": "Ada L.", "emails": []any{map[string]any{"addr": "ada@example.test"}}},
		})
		if result["conflict"] != true {
			t.Fatalf("want a conflict: %v", result)
		}
		current, _ := result["current"].(map[string]any)
		if str(current, "name") != "Augusta Ada King" {
			t.Fatalf("the server's copy should be returned: %v", result)
		}
		if _, card := server.dav(t, "GET", cardURL, "", nil); strings.Contains(card, "Ada L.") {
			t.Fatalf("nothing should have been written:\n%s", card)
		}
		// Keeping mine writes over the version now shown.
		kept := callMap(t, sidecar, "people.save", map[string]any{
			"id": str(stale, "id"), "version": str(current, "version"),
			"person": map[string]any{"name": "Ada L.", "emails": []any{map[string]any{"addr": "ada@example.test"}}},
		})
		if kept["ok"] != true {
			t.Fatalf("keep mine: %v", kept)
		}
	})

	t.Run("a new contact is created in the book", func(t *testing.T) {
		result := callMap(t, sidecar, "people.save", map[string]any{
			"book":   sourceID,
			"person": map[string]any{"name": "Grace Hopper", "emails": []any{map[string]any{"addr": "grace@example.test"}}},
		})
		if result["ok"] != true {
			t.Fatalf("create: %v", result)
		}
		if synced := callMap(t, sidecar, "carddav.sync", map[string]any{"id": sourceID}); synced["ok"] != true {
			t.Fatalf("sync after create: %v", synced)
		}
		rows, _ := callMap(t, sidecar, "people.list", map[string]any{"query": "Grace"})["people"].([]any)
		if len(rows) != 1 || str(rows[0].(map[string]any), "source") != "carddav" {
			t.Fatalf("the new contact should be read back from the server: %v", rows)
		}
	})

	t.Run("a delete from an older version deletes nothing", func(t *testing.T) {
		current := findAda()
		if status, _ := server.dav(t, "PUT", cardURL, ada, map[string]string{"Content-Type": "text/vcard"}); status >= 300 {
			t.Fatal("touch on the server failed")
		}
		result := callMap(t, sidecar, "people.delete", map[string]any{"id": str(current, "id"), "version": str(current, "version")})
		if result["conflict"] != true {
			t.Fatalf("want a conflict: %v", result)
		}
		if status, _ := server.dav(t, "GET", cardURL, "", nil); status != 200 {
			t.Fatalf("the card should still be there: HTTP %d", status)
		}
		fresh, _ := result["current"].(map[string]any)
		gone := callMap(t, sidecar, "people.delete", map[string]any{"id": str(current, "id"), "version": str(fresh, "version")})
		if gone["ok"] != true {
			t.Fatalf("delete: %v", gone)
		}
		if status, _ := server.dav(t, "GET", cardURL, "", nil); status != 404 {
			t.Fatalf("the card should be gone: HTTP %d", status)
		}
	})
}
