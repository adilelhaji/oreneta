//go:build integration

package main

import (
	"regexp"
	"strings"
	"testing"
)

// Contact groups on a real CardDAV server (ADR-0052): both ways of writing a
// group are read; a new group is written the way the book already writes
// cards; a membership change keeps every field and member the app does not
// know; a change made on the server meanwhile is a conflict that writes
// nothing; deleting a group leaves its people. Radicale stands in for a
// server; no provider is certified.
func TestIntegrationContactGroups(t *testing.T) {
	server := startRadicale(t)
	sidecar, _ := startSidecar(t)
	vcard := map[string]string{"Content-Type": "text/vcard"}

	groupsOf := func(book string) []map[string]any {
		rows, _ := callMap(t, sidecar, "people.groups", map[string]any{})["groups"].([]any)
		var out []map[string]any
		for _, row := range rows {
			group := row.(map[string]any)
			if str(group, "book") == book {
				out = append(out, group)
			}
		}
		return out
	}
	memberAddrs := func(group map[string]any) []string {
		members, _ := group["members"].([]any)
		var out []string
		for _, member := range members {
			out = append(out, str(member.(map[string]any), "addr"))
		}
		return out
	}
	personID := func(name string) string {
		rows, _ := callMap(t, sidecar, "people.list", map[string]any{"query": name})["people"].([]any)
		if len(rows) != 1 {
			t.Fatalf("people.list %q = %v", name, rows)
		}
		return str(rows[0].(map[string]any), "id")
	}
	addBook := func(name string) string {
		added := callMap(t, sidecar, "carddav.add", map[string]any{
			"url": server.bookURL(name), "name": name, "username": radicaleUser, "password": testPassword,
		})
		if added["synced"] != true {
			t.Fatalf("first sync of %s: %v", name, added)
		}
		return str(added, "id")
	}

	t.Run("an Apple-style book gets an Apple-style group and keeps what it does not know", func(t *testing.T) {
		server.createAddressBook(t, "apple", "Apple book")
		server.putVCard(t, "apple", "itest-ada", "Ada Lovelace", "ada@example.test")
		server.putVCard(t, "apple", "itest-bob", "Bob Babbage", "bob@example.test")
		book := addBook("apple")
		if groups := groupsOf(book); len(groups) != 0 {
			t.Fatalf("no groups yet: %v", groups)
		}
		created := callMap(t, sidecar, "people.groupSave", map[string]any{
			"book": book, "name": "Engines", "members": []any{personID("Ada")},
		})
		if created["ok"] != true {
			t.Fatalf("create group: %v", created)
		}
		groups := groupsOf(book)
		if len(groups) != 1 || str(groups[0], "name") != "Engines" || strings.Join(memberAddrs(groups[0]), ",") != "ada@example.test" {
			t.Fatalf("groups after create: %v", groups)
		}
		groupURL := ""
		_, listing := server.dav(t, "PROPFIND", server.bookURL("apple"), "", map[string]string{"Depth": "1"})
		for _, match := range regexp.MustCompile(`href>([^<]+\.vcf)<`).FindAllStringSubmatch(listing, -1) {
			if !strings.Contains(match[1], "itest-") {
				groupURL = server.baseURL() + strings.TrimPrefix(match[1], "/")
			}
		}
		if groupURL == "" {
			t.Fatalf("the group card should be on the server:\n%s", listing)
		}
		_, card := server.dav(t, "GET", groupURL, "", nil)
		for _, want := range []string{"VERSION:3.0", "X-ADDRESSBOOKSERVER-KIND:group", "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:itest-ada", "FN:Engines"} {
			if !strings.Contains(card, want) {
				t.Fatalf("group card lacks %q:\n%s", want, card)
			}
		}
		// Another client adds a field the app does not know.
		withExtra := strings.Replace(card, "END:VCARD", "X-OTHER-CLIENT:keep me\r\nEND:VCARD", 1)
		if status, reply := server.dav(t, "PUT", groupURL, withExtra, vcard); status >= 300 {
			t.Fatalf("change on the server: HTTP %d %s", status, reply)
		}
		stale := groups[0]
		conflict := callMap(t, sidecar, "people.groupSave", map[string]any{
			"id": str(stale, "id"), "version": str(stale, "version"), "name": "Engines",
			"members": []any{personID("Ada"), personID("Bob")},
		})
		if conflict["conflict"] != true {
			t.Fatalf("want a conflict: %v", conflict)
		}
		if _, now := server.dav(t, "GET", groupURL, "", nil); strings.Contains(now, "itest-bob") {
			t.Fatalf("nothing should have been written:\n%s", now)
		}
		if synced := callMap(t, sidecar, "carddav.sync", map[string]any{"id": book}); synced["ok"] != true {
			t.Fatalf("sync: %v", synced)
		}
		fresh := groupsOf(book)[0]
		saved := callMap(t, sidecar, "people.groupSave", map[string]any{
			"id": str(fresh, "id"), "version": str(fresh, "version"), "name": "Analytical engines",
			"members": []any{personID("Bob")},
		})
		if saved["ok"] != true {
			t.Fatalf("save: %v", saved)
		}
		_, now := server.dav(t, "GET", groupURL, "", nil)
		for _, want := range []string{"X-OTHER-CLIENT:keep me", "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:itest-bob", "FN:Analytical engines"} {
			if !strings.Contains(now, want) {
				t.Fatalf("group card lacks %q:\n%s", want, now)
			}
		}
		if strings.Contains(now, "itest-ada") {
			t.Fatalf("Ada should have been taken out:\n%s", now)
		}
		after := groupsOf(book)[0]
		gone := callMap(t, sidecar, "people.groupDelete", map[string]any{"id": str(after, "id"), "version": str(after, "version")})
		if gone["ok"] != true {
			t.Fatalf("delete: %v", gone)
		}
		if status, _ := server.dav(t, "GET", groupURL, "", nil); status != 404 {
			t.Fatalf("the group card should be gone: HTTP %d", status)
		}
		personID("Bob") // the people stay
	})

	t.Run("a vCard 4 group is read and changed in its own terms", func(t *testing.T) {
		server.createAddressBook(t, "v4", "vCard 4 book")
		server.putVCard(t, "v4", "itest-cy", "Cy Dao", "cy@example.test")
		server.putVCard(t, "v4", "itest-di", "Di Roe", "di@example.test")
		groupURL := server.bookURL("v4") + "itest-team.vcf"
		team := "BEGIN:VCARD\r\nVERSION:4.0\r\nKIND:group\r\nUID:itest-team\r\nFN:Team\r\n" +
			"MEMBER:urn:uuid:itest-cy\r\nMEMBER:mailto:list@example.test\r\nMEMBER:urn:uuid:itest-not-here\r\nX-TEAM-COLOUR:blue\r\nEND:VCARD\r\n"
		if status, reply := server.dav(t, "PUT", groupURL, team, vcard); status != 201 {
			t.Fatalf("seed PUT: HTTP %d %s", status, reply)
		}
		book := addBook("v4")
		groups := groupsOf(book)
		if len(groups) != 1 || str(groups[0], "name") != "Team" || strings.Join(memberAddrs(groups[0]), ",") != "cy@example.test" {
			t.Fatalf("groups: %v", groups)
		}
		// The group card is not a person.
		if rows, _ := callMap(t, sidecar, "people.list", map[string]any{"query": "Team"})["people"].([]any); len(rows) != 0 {
			t.Fatalf("a group card listed as a person: %v", rows)
		}
		saved := callMap(t, sidecar, "people.groupSave", map[string]any{
			"id": str(groups[0], "id"), "version": str(groups[0], "version"), "name": "Team",
			"members": []any{personID("Cy"), personID("Di")},
		})
		if saved["ok"] != true {
			t.Fatalf("save: %v", saved)
		}
		_, card := server.dav(t, "GET", groupURL, "", nil)
		for _, want := range []string{"KIND:group", "MEMBER:urn:uuid:itest-di", "MEMBER:mailto:list@example.test", "MEMBER:urn:uuid:itest-not-here", "X-TEAM-COLOUR:blue", "MEMBER:urn:uuid:itest-cy"} {
			if !strings.Contains(card, want) {
				t.Fatalf("group card lacks %q:\n%s", want, card)
			}
		}
		if strings.Contains(card, "X-ADDRESSBOOKSERVER") {
			t.Fatalf("a vCard 4 group should stay vCard 4:\n%s", card)
		}
		// A new group in this book follows the group already there.
		created := callMap(t, sidecar, "people.groupSave", map[string]any{"book": book, "name": "Second", "members": []any{personID("Di")}})
		if created["ok"] != true {
			t.Fatalf("create: %v", created)
		}
		if synced := callMap(t, sidecar, "carddav.sync", map[string]any{"id": book}); synced["ok"] != true {
			t.Fatalf("sync: %v", synced)
		}
		if got := len(groupsOf(book)); got != 2 {
			t.Fatalf("want two groups after sync, got %d", got)
		}
	})
}
