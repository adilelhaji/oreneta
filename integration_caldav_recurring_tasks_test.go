//go:build integration

package main

import (
	"strings"
	"testing"
)

// Repeating tasks in a list kept on a CalDAV server, against a real one
// (#103, ADR-0053): another client's weekly task is read as one this app
// changes; completing an occurrence moves the series (DUE, DTSTART, RRULE
// with what is left) and keeps a completed copy as a new object, with what
// the other client wrote kept; a monthly task on the last Friday made here
// arrives with its rule spelled out; stopping the repetition removes the rule
// and completes the task. Radicale in Docker stands in for a server; no
// provider is certified.
func TestIntegrationCalDAVRecurringTasks(t *testing.T) {
	server := startRadicale(t)
	sidecar, _ := startSidecar(t)

	collection := server.bookURL("habits")
	mkcalendar := `<?xml version="1.0" encoding="UTF-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Habits</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
  </D:prop></D:set>
</D:mkcol>`
	if status, reply := server.dav(t, "MKCOL", collection, mkcalendar, map[string]string{"Content-Type": "application/xml"}); status != 201 {
		t.Fatalf("MKCOL: HTTP %d %s", status, reply)
	}
	weekly := collection + "water.ics"
	seed := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Itest//EN\r\nBEGIN:VTODO\r\nUID:water@itest\r\n" +
		"DTSTAMP:20260101T000000Z\r\nSUMMARY:Water the plants\r\nX-ITEST:keep\r\nCATEGORIES:home\r\n" +
		"DTSTART;VALUE=DATE:20261013\r\nDUE;VALUE=DATE:20261013\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSTATUS:NEEDS-ACTION\r\n" +
		"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Water\r\nTRIGGER;RELATED=END:-PT6H\r\nEND:VALARM\r\n" +
		"END:VTODO\r\nEND:VCALENDAR\r\n"
	if status, reply := server.dav(t, "PUT", weekly, seed, map[string]string{"Content-Type": "text/calendar"}); status != 201 {
		t.Fatalf("seed: HTTP %d %s", status, reply)
	}
	get := func(url string) string {
		t.Helper()
		status, body := server.dav(t, "GET", url, "", nil)
		if status != 200 {
			t.Fatalf("GET %s: HTTP %d %s", url, status, body)
		}
		return strings.ReplaceAll(body, "\r\n ", "")
	}
	// Every object in the collection, unfolded.
	objects := func() []string {
		t.Helper()
		report := `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>`
		status, body := server.dav(t, "REPORT", collection, report, map[string]string{"Content-Type": "application/xml", "Depth": "1"})
		if status != 207 {
			t.Fatalf("REPORT: HTTP %d\n%s", status, body)
		}
		var out []string
		for _, part := range strings.Split(body, "BEGIN:VCALENDAR")[1:] {
			out = append(out, strings.ReplaceAll(strings.ReplaceAll(part, "\r\n ", ""), "\n ", ""))
		}
		return out
	}

	added := callMap(t, sidecar, "tasks.caldavAdd", map[string]any{
		"url": collection, "name": "Habits", "server": server.userURL(), "username": radicaleUser, "password": testPassword,
	})
	list := str(added, "id")
	rows := func() []map[string]any {
		t.Helper()
		var out []map[string]any
		listed := callMap(t, sidecar, "tasks.list", map[string]any{"include_completed": true})
		for _, row := range listed["tasks"].([]any) {
			if task := row.(map[string]any); str(task, "list_id") == list {
				out = append(out, task)
			}
		}
		return out
	}
	syncList := func() {
		t.Helper()
		result := callMap(t, sidecar, "tasks.sync", map[string]any{"list_id": list})
		if lists := result["lists"].([]any); len(lists) != 1 || lists[0].(map[string]any)["ok"] != true {
			t.Fatalf("sync: %v", result)
		}
	}

	first := rows()
	if len(first) != 1 || first[0]["recurring"] != false || first[0]["recurrence"] == nil {
		t.Fatalf("a weekly task is one this app changes: %v", first)
	}
	id := first[0]["id"]

	t.Run("completing an occurrence moves the series and keeps a record", func(t *testing.T) {
		done := callMap(t, sidecar, "tasks.setCompleted", map[string]any{"id": id, "completed": true})
		if done["next_due"] == nil {
			t.Fatalf("want a next due date: %v", done)
		}
		syncList()
		body := get(weekly)
		for _, want := range []string{
			"DUE;VALUE=DATE:20261020", "DTSTART;VALUE=DATE:20261020", "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2",
			"STATUS:NEEDS-ACTION", "X-ITEST:keep", "CATEGORIES:home", "TRIGGER;RELATED=END:-PT6H", "UID:water@itest",
		} {
			if !strings.Contains(body, want) {
				t.Fatalf("server lost %q:\n%s", want, body)
			}
		}
		all := objects()
		if len(all) != 2 {
			t.Fatalf("want the series and a record, got %d", len(all))
		}
		var record string
		for _, object := range all {
			if !strings.Contains(object, "UID:water@itest") {
				record = object
			}
		}
		if !strings.Contains(record, "STATUS:COMPLETED") || !strings.Contains(record, "DUE;VALUE=DATE:20261013") || strings.Contains(record, "RRULE") {
			t.Fatalf("record:\n%s", record)
		}
		// Read back: nothing changes, nothing conflicts.
		syncList()
		open, completed := 0, 0
		for _, task := range rows() {
			if str(task, "conflict") != "" || str(task, "pending") != "" {
				t.Fatalf("settled: %v", task)
			}
			if task["completed_at"] == nil {
				open++
			} else {
				completed++
			}
		}
		if open != 1 || completed != 1 {
			t.Fatalf("one open, one done: %v", rows())
		}
	})

	t.Run("a monthly task made here arrives with its rule spelled out", func(t *testing.T) {
		stored := callMap(t, sidecar, "tasks.get", map[string]any{"id": id})
		due := stored["due_at"]
		callMap(t, sidecar, "tasks.create", map[string]any{"task": map[string]any{
			"list_id": list, "title": "Pay the rent", "priority": 1, "due_at": due,
			"recurrence": map[string]any{"freq": "monthly", "interval": 1, "month_week": -1, "weekdays": []int{4}},
		}})
		syncList()
		var found string
		for _, object := range objects() {
			if strings.Contains(object, "SUMMARY:Pay the rent") {
				found = object
			}
		}
		if !strings.Contains(found, "RRULE:FREQ=MONTHLY;BYDAY=-1FR") || !strings.Contains(found, "DTSTART;VALUE=DATE:") {
			t.Fatalf("new repeating task:\n%s", found)
		}
	})

	t.Run("stopping the repetition removes the rule and completes the task", func(t *testing.T) {
		callMap(t, sidecar, "tasks.setCompleted", map[string]any{"id": id, "completed": true, "stop_repeating": true})
		syncList()
		body := get(weekly)
		if strings.Contains(body, "RRULE") || !strings.Contains(body, "STATUS:COMPLETED") || !strings.Contains(body, "X-ITEST:keep") {
			t.Fatalf("stopped:\n%s", body)
		}
	})
}
