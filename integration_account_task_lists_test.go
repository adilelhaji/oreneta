//go:build integration

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The task lists of a CalDAV server added to an account arrive with it
// (#281, ADR-0070), against a real server: each collection says what it
// takes, the ones that take tasks only or hold a task are offered checked,
// the chosen one is read behind the answer and announced, the unchecked one
// is declined, a deleted list does not come back on a sync, and it is added
// again with the password of a calendar of the same server and user.
// Radicale in Docker stands in for a server; no provider is certified.
func TestIntegrationAccountTaskLists(t *testing.T) {
	server := startRadicale(t)
	sidecar, events := startSidecar(t)

	mkcalendar := func(name, display, components string) string {
		t.Helper()
		url := server.bookURL(name)
		set := ""
		if components != "" {
			set = "<C:supported-calendar-component-set>" + components + "</C:supported-calendar-component-set>"
		}
		body := `<?xml version="1.0" encoding="UTF-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>` + display + `</D:displayname>` + set + `
  </D:prop></D:set>
</D:mkcol>`
		if status, reply := server.dav(t, "MKCOL", url, body, map[string]string{"Content-Type": "application/xml"}); status != 201 {
			t.Fatalf("MKCOL %s: HTTP %d %s", name, status, reply)
		}
		return url
	}
	putTodo := func(collection, uid, summary string) {
		t.Helper()
		ics := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Itest//EN\r\nBEGIN:VTODO\r\nUID:" + uid + "\r\n" +
			"DTSTAMP:20260101T000000Z\r\nSUMMARY:" + summary + "\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
		if status, reply := server.dav(t, "PUT", collection+uid+".ics", ics, map[string]string{"Content-Type": "text/calendar"}); status != 201 {
			t.Fatalf("PUT %s: HTTP %d %s", uid, status, reply)
		}
	}
	chores := mkcalendar("acct-chores", "Chores", `<C:comp name="VTODO"/>`)
	family := mkcalendar("acct-family", "Family", "")
	plans := mkcalendar("acct-plans", "Plans", `<C:comp name="VEVENT"/><C:comp name="VTODO"/>`)
	work := mkcalendar("acct-work", "Work", `<C:comp name="VEVENT"/>`)
	putTodo(chores, "wash@itest", "Wash up")
	putTodo(family, "call@itest", "Call grandma")

	// The lists hang off an account; the local archive needs no mail server.
	eml := filepath.Join(t.TempDir(), "one.eml")
	if err := os.WriteFile(eml, []byte("From: a@example.test\r\nSubject: hi\r\nMessage-ID: <1@x>\r\n\r\nhi\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	callMap(t, sidecar, "archive.import", map[string]any{"paths": []any{eml}})
	const account = "local-archive"

	found := callMap(t, sidecar, "caldav.discover", map[string]any{"server": server.userURL(), "username": radicaleUser, "password": testPassword})
	byURL := map[string]map[string]any{}
	for _, item := range found["calendars"].([]any) {
		row := item.(map[string]any)
		byURL[str(row, "url")] = row
	}
	for url, want := range map[string][2]bool{
		chores: {false, true}, // tasks only
		family: {true, true},  // says nothing, holds a task
		plans:  {true, false}, // events and tasks, holds none
		work:   {true, false}, // events only
	} {
		row := byURL[url]
		if row == nil || row["events"] != want[0] || row["tasks"] != want[1] {
			t.Fatalf("%s: want events=%v tasks=%v, got %v", url, want[0], want[1], row)
		}
	}

	added := callMap(t, sidecar, "caldav.add", map[string]any{
		"account": account, "server": server.userURL(), "username": radicaleUser, "password": testPassword,
		"calendars": []any{byURL[work]}, "task_lists": []any{chores}, "declined_task_lists": []any{family},
	})
	if lists, _ := added["task_lists"].([]any); len(lists) != 1 || lists[0] != chores {
		t.Fatalf("caldav.add: %v", added)
	}

	entryOf := func(url string) map[string]any {
		t.Helper()
		listed := callMap(t, sidecar, "tasks.lists", map[string]any{})
		for _, item := range listed["account_lists"].([]any) {
			entry := item.(map[string]any)
			if str(entry, "account") == account && str(entry, "url") == url {
				return entry
			}
		}
		return nil
	}
	// Read behind the answer, and announced when it is here.
	deadline := time.Now().Add(20 * time.Second)
	for entryOf(chores) == nil || str(entryOf(chores), "state") != "linked" {
		if time.Now().After(deadline) {
			t.Fatalf("the list never arrived: %v", entryOf(chores))
		}
		time.Sleep(100 * time.Millisecond)
	}
	list := str(entryOf(chores), "list_id")
	announced := events.count(func(event sidecarEvent) bool {
		return event.name == "tasks.changed" && event.detail["list_id"] == list
	})
	if announced != 1 {
		t.Fatalf("tasks.changed for %s: %d", list, announced)
	}
	if entry := entryOf(family); entry == nil || str(entry, "state") != "declined" {
		t.Fatalf("the unchecked collection is declined: %v", entry)
	}
	titles := func() map[string]bool {
		t.Helper()
		out := map[string]bool{}
		for _, row := range callMap(t, sidecar, "tasks.list", map[string]any{})["tasks"].([]any) {
			task := row.(map[string]any)
			if str(task, "list_id") == list {
				out[str(task, "title")] = true
			}
		}
		return out
	}
	if !titles()["Wash up"] {
		t.Fatalf("the list's tasks: %v", titles())
	}

	t.Run("a deleted list stays deleted on a sync", func(t *testing.T) {
		callMap(t, sidecar, "tasks.deleteList", map[string]any{"id": list})
		callMap(t, sidecar, "tasks.sync", map[string]any{})
		if entry := entryOf(chores); str(entry, "state") != "declined" || str(entry, "list_id") != "" {
			t.Fatalf("after a sync: %v", entry)
		}
		for _, item := range callMap(t, sidecar, "tasks.lists", map[string]any{})["lists"].([]any) {
			if str(item.(map[string]any), "remote_url") == chores {
				t.Fatalf("the list came back: %v", item)
			}
		}
	})

	t.Run("added again with the password of a calendar of the same server", func(t *testing.T) {
		again := callMap(t, sidecar, "tasks.caldavAdd", map[string]any{"account": account, "url": chores})
		if str(again, "id") == "" || str(entryOf(chores), "state") != "linked" {
			t.Fatalf("added again: %v / %v", again, entryOf(chores))
		}
		callMap(t, sidecar, "tasks.declineAccountList", map[string]any{"account": account, "source": str(entryOf(chores), "source")})
		if entry := entryOf(chores); str(entry, "state") != "declined" {
			t.Fatalf("declined: %v", entry)
		}
	})
}
