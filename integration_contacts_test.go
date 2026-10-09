//go:build integration

package main

import (
	"strings"
	"testing"
)

// The CardDAV route against a real server, in isolation: discovery from a
// bare address, a first read, a change picked up by a later sync, a refused
// password reported as such, and a server that goes away without taking the
// contacts already read with it. Radicale in Docker stands in for a server;
// no provider is certified by this.
func TestIntegrationContacts(t *testing.T) {
	server := startRadicale(t)
	sidecar, _ := startSidecar(t)

	server.createAddressBook(t, "contacts", "Team contacts")
	server.putVCard(t, "contacts", "itest-ada", "Ada Lovelace", "ada@example.test")

	var sourceID string

	t.Run("discovers the address books behind a server address", func(t *testing.T) {
		result := callMap(t, sidecar, "carddav.discover", map[string]any{
			"server":   server.baseURL(),
			"username": radicaleUser,
			"password": testPassword,
		})
		books, _ := result["books"].([]any)
		var found bool
		for _, row := range books {
			book := row.(map[string]any)
			if strings.HasSuffix(str(book, "url"), "/"+radicaleUser+"/contacts/") {
				found = true
				if name := str(book, "name"); name != "Team contacts" {
					t.Errorf("book name = %q, want the server's display name", name)
				}
			}
		}
		if !found {
			t.Fatalf("discovery did not find the test book: %v", result)
		}
	})

	t.Run("adds a book and reads its contacts", func(t *testing.T) {
		result := callMap(t, sidecar, "carddav.add", map[string]any{
			"url":      server.bookURL("contacts"),
			"name":     "Team contacts",
			"username": radicaleUser,
			"password": testPassword,
		})
		if result["synced"] != true {
			t.Fatalf("first sync did not succeed: %v", result)
		}
		sourceID = str(result, "id")
		if sourceID == "" {
			t.Fatalf("no source id in %v", result)
		}
		people := callMap(t, sidecar, "people.list", map[string]any{"query": "Ada"})
		rows, _ := people["people"].([]any)
		if len(rows) != 1 {
			t.Fatalf("people.list = %v, want Ada alone", people)
		}
		person := rows[0].(map[string]any)
		if str(person, "name") != "Ada Lovelace" || str(person, "source") != "carddav" {
			t.Fatalf("person = %v", person)
		}
		if !strings.Contains(stringifyEmails(person), "ada@example.test") {
			t.Fatalf("person emails = %v", person["emails"])
		}
	})

	t.Run("a change on the server reaches the next sync", func(t *testing.T) {
		server.putVCard(t, "contacts", "itest-grace", "Grace Hopper", "grace@example.test")
		result := callMap(t, sidecar, "carddav.sync", map[string]any{"id": sourceID})
		if result["ok"] != true {
			t.Fatalf("sync after a server change failed: %v", result)
		}
		people := callMap(t, sidecar, "people.list", map[string]any{"query": ""})
		if n := countSource(people, "carddav"); n != 2 {
			t.Fatalf("%d CardDAV people after the second contact, want 2: %v", n, people)
		}
	})

	t.Run("a refused password is reported, not hidden", func(t *testing.T) {
		result := callMap(t, sidecar, "carddav.add", map[string]any{
			"url":      server.bookURL("contacts"),
			"name":     "Wrong password",
			"username": radicaleUser,
			"password": "not-the-password",
		})
		if result["synced"] != false || str(result, "error") == "" {
			t.Fatalf("a refused password should fail with a reason: %v", result)
		}
		sources := callMap(t, sidecar, "carddav.list", map[string]any{})
		rows, _ := sources["sources"].([]any)
		if len(rows) != 2 {
			t.Fatalf("carddav.list = %v, want both sources kept", sources)
		}
		// The wrong-password source is kept with its error, so the reader sees
		// what went wrong; the good one is untouched.
		var kept bool
		for _, row := range rows {
			source := row.(map[string]any)
			if str(source, "id") == str(result, "id") && str(source, "lastError") != "" {
				kept = true
			}
		}
		if !kept {
			t.Fatalf("the failed source should carry its error: %v", sources)
		}
		callMap(t, sidecar, "carddav.remove", map[string]any{"id": str(result, "id")})
	})

	t.Run("an unreachable server keeps the contacts already read", func(t *testing.T) {
		server.stop(t)
		result := callMap(t, sidecar, "carddav.sync", map[string]any{"id": sourceID})
		if result["ok"] != false {
			t.Fatalf("sync against a stopped server should fail honestly: %v", result)
		}
		people := callMap(t, sidecar, "people.list", map[string]any{"query": ""})
		if n := countSource(people, "carddav"); n != 2 {
			t.Fatalf("%d CardDAV people after an unreachable sync, want the 2 already read", n)
		}
	})
}

func stringifyEmails(person map[string]any) string {
	emails, _ := person["emails"].([]any)
	var parts []string
	for _, row := range emails {
		if email, ok := row.(map[string]any); ok {
			parts = append(parts, str(email, "addr"))
		}
	}
	return strings.Join(parts, ",")
}

func countSource(people map[string]any, source string) int {
	rows, _ := people["people"].([]any)
	n := 0
	for _, row := range rows {
		if person, ok := row.(map[string]any); ok && str(person, "source") == source {
			n++
		}
	}
	return n
}
