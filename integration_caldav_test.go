//go:build integration

package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// CalDAV against a real server (#101, ADR-0018): calendars are found and
// read, an edit keeps what the app does not show, a change made on the
// server meanwhile is a conflict that writes nothing, and a series can be
// changed one occurrence at a time. Radicale in Docker stands in for a
// server; no provider is certified.
func TestIntegrationCalDAV(t *testing.T) {
	server := startRadicale(t)
	sidecar, _ := startSidecar(t)

	calendarURL := server.bookURL("work")
	mkcalendar := `<?xml version="1.0" encoding="UTF-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Work</D:displayname>
  </D:prop></D:set>
</D:mkcol>`
	if status, reply := server.dav(t, "MKCOL", calendarURL, mkcalendar, map[string]string{"Content-Type": "application/xml"}); status != 201 {
		t.Fatalf("MKCOL: HTTP %d %s", status, reply)
	}
	review := calendarURL + "review.ics"
	seed := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Itest//EN\r\nBEGIN:VEVENT\r\nUID:review@itest\r\n" +
		"DTSTAMP:20260101T000000Z\r\nDTSTART:20260310T090000Z\r\nDTEND:20260310T100000Z\r\nSUMMARY:Review\r\n" +
		"ORGANIZER;CN=Ana:mailto:ana@example.test\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:bo@example.test\r\n" +
		"X-ITEST:keep\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	if status, reply := server.dav(t, "PUT", review, seed, map[string]string{"Content-Type": "text/calendar"}); status != 201 {
		t.Fatalf("seed: HTTP %d %s", status, reply)
	}

	// The calendars hang off an account; the local archive is one that
	// needs no mail server.
	eml := filepath.Join(t.TempDir(), "one.eml")
	if err := os.WriteFile(eml, []byte("From: a@example.test\r\nSubject: hi\r\nMessage-ID: <1@x>\r\n\r\nhi\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	callMap(t, sidecar, "archive.import", map[string]any{"paths": []any{eml}})
	const account = "local-archive"

	found := callMap(t, sidecar, "caldav.discover", map[string]any{"server": server.userURL(), "username": radicaleUser, "password": testPassword})
	calendars, _ := found["calendars"].([]any)
	if len(calendars) != 1 || str(calendars[0].(map[string]any), "name") != "Work" {
		t.Fatalf("discover: %v", found)
	}
	callMap(t, sidecar, "caldav.add", map[string]any{
		"account": account, "username": radicaleUser, "password": testPassword, "calendars": calendars,
	})

	from := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC).Unix()
	to := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC).Unix()
	// The calendar refreshes behind each request; this waits until the
	// cached window holds what the test expects.
	eventsWhere := func(want int, ok func([]map[string]any) bool) []map[string]any {
		t.Helper()
		var rows []map[string]any
		deadline := time.Now().Add(15 * time.Second)
		for attempt := 0; ; attempt++ {
			listed := callMap(t, sidecar, "calendar.events", map[string]any{"account": account, "from": from, "to": to, "refresh": attempt%5 == 0})
			rows = rows[:0]
			for _, row := range listed["events"].([]any) {
				rows = append(rows, row.(map[string]any))
			}
			sort.Slice(rows, func(i, j int) bool { return rows[i]["start"].(float64) < rows[j]["start"].(float64) })
			if len(rows) == want && (ok == nil || ok(rows)) {
				return rows
			}
			if time.Now().After(deadline) {
				t.Fatalf("want %d events, have %v", want, rows)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	events := func(want int) []map[string]any { t.Helper(); return eventsWhere(want, nil) }
	count := func(rows []map[string]any, subject string) int {
		n := 0
		for _, row := range rows {
			if str(row, "subject") == subject {
				n++
			}
		}
		return n
	}

	first := events(1)[0]
	if str(first, "subject") != "Review" || str(first, "change_key") == "" {
		t.Fatalf("read: %v", first)
	}

	t.Run("an edit keeps the attendees and the other client's lines", func(t *testing.T) {
		edited := copyMap(first)
		edited["subject"] = "Review, moved"
		edited["location"] = "Room 2"
		if _, err := sidecar.Call("calendar.update", map[string]any{"account": account, "event": edited}); err != nil {
			t.Fatal(err)
		}
		_, body := server.dav(t, "GET", review, "", nil)
		for _, want := range []string{"SUMMARY:Review\\, moved", "LOCATION:Room 2", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bo@example.test", "X-ITEST:keep", "UID:review@itest"} {
			if !strings.Contains(body, want) {
				t.Fatalf("server lost %q:\n%s", want, body)
			}
		}
	})

	t.Run("a change made on the server meanwhile writes nothing", func(t *testing.T) {
		stale := eventsWhere(1, func(rows []map[string]any) bool { return str(rows[0], "subject") == "Review, moved" })[0]
		_, body := server.dav(t, "GET", review, "", nil)
		elsewhere := strings.Replace(body, "LOCATION:Room 2", "LOCATION:Room 9", 1)
		if status, reply := server.dav(t, "PUT", review, elsewhere, map[string]string{"Content-Type": "text/calendar"}); status >= 300 {
			t.Fatalf("change on the server: HTTP %d %s", status, reply)
		}
		mine := copyMap(stale)
		mine["subject"] = "Mine"
		_, err := sidecar.Call("calendar.update", map[string]any{"account": account, "event": mine})
		if err == nil || !strings.Contains(err.Error(), "changed or removed on the server") {
			t.Fatalf("want a conflict, got %v", err)
		}
		if _, body := server.dav(t, "GET", review, "", nil); !strings.Contains(body, "LOCATION:Room 9") || strings.Contains(body, "SUMMARY:Mine") {
			t.Fatalf("nothing should have been written:\n%s", body)
		}
	})

	t.Run("a series is created and changed one occurrence at a time", func(t *testing.T) {
		start := time.Date(2026, 3, 16, 8, 0, 0, 0, time.UTC).Unix()
		created := callMap(t, sidecar, "calendar.create", map[string]any{"account": account, "event": map[string]any{
			"id": "", "calendar_id": calendarURL, "subject": "Stand-up", "start": start, "end": start + 900,
			"recurrence": map[string]any{"freq": "weekly", "interval": 1, "count": 3},
		}})
		if created["event"] == nil {
			t.Fatalf("create: %v", created)
		}
		rows := events(4)
		var series []map[string]any
		for _, row := range rows {
			if str(row, "subject") == "Stand-up" {
				series = append(series, row)
			}
		}
		if len(series) != 3 {
			t.Fatalf("want three occurrences: %v", rows)
		}
		second := copyMap(series[1])
		second["subject"] = "Stand-up (moved)"
		if _, err := sidecar.Call("calendar.update", map[string]any{"account": account, "event": second}); err != nil {
			t.Fatal(err)
		}
		fresh := eventsWhere(4, func(rows []map[string]any) bool { return count(rows, "Stand-up (moved)") == 1 })
		if count(fresh, "Stand-up") != 2 {
			t.Fatalf("only the one occurrence changes: %v", fresh)
		}
		third := series[2]
		for _, row := range fresh {
			if row["id"] == third["id"] {
				third = row
			}
		}
		if _, err := sidecar.Call("calendar.delete", map[string]any{
			"account": account, "event": third["id"], "calendar": calendarURL,
			"change_key": third["change_key"], "series": third["series_id"],
		}); err != nil {
			t.Fatal(err)
		}
		eventsWhere(3, func(rows []map[string]any) bool { return count(rows, "Stand-up") == 1 })
	})

	t.Run("a .ics file goes to the server with its rule, once", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "in.ics")
		ics := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Itest//EN\r\nBEGIN:VEVENT\r\nUID:yoga@itest\r\n" +
			"DTSTAMP:20260101T000000Z\r\nDTSTART:20260305T180000Z\r\nDTEND:20260305T190000Z\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\n" +
			"SUMMARY:Yoga\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
		if err := os.WriteFile(file, []byte(ics), 0o600); err != nil {
			t.Fatal(err)
		}
		params := map[string]any{"account": account, "calendar": calendarURL, "path": file, "confirm": true}
		first := callMap(t, sidecar, "calendar.importIcs", params)
		if summary := first["summary"].(map[string]any); summary["added"] != float64(1) || summary["series"] != float64(1) {
			t.Fatalf("import: %v", first)
		}
		status, body := server.dav(t, "GET", calendarURL+"yoga_itest.ics", "", nil)
		if status != 200 || !strings.Contains(body, "RRULE:FREQ=WEEKLY;COUNT=2") {
			t.Fatalf("the series should be on the server with its rule: HTTP %d\n%s", status, body)
		}
		again := callMap(t, sidecar, "calendar.importIcs", params)
		if summary := again["summary"].(map[string]any); summary["added"] != float64(0) || summary["duplicates"] != float64(1) {
			t.Fatalf("a second import adds nothing: %v", again)
		}
		eventsWhere(5, func(rows []map[string]any) bool { return count(rows, "Yoga") == 2 })
	})
}

func copyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
