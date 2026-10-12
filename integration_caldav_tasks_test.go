//go:build integration

package main

import (
	"strings"
	"testing"
)

// Task lists kept on a CalDAV server, against a real one (#103, ADR-0039):
// a collection of tasks is found and bound to a new list, read, edited here
// with what another client wrote kept, edited on both sides into a conflict
// that writes nothing until the person chooses, and deleting the list here
// leaves the server alone. Radicale in Docker stands in for a server; no
// provider is certified.
func TestIntegrationCalDAVTasks(t *testing.T) {
	server := startRadicale(t)
	sidecar, _ := startSidecar(t)

	collection := server.bookURL("todo")
	mkcalendar := `<?xml version="1.0" encoding="UTF-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Chores</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
  </D:prop></D:set>
</D:mkcol>`
	if status, reply := server.dav(t, "MKCOL", collection, mkcalendar, map[string]string{"Content-Type": "application/xml"}); status != 201 {
		t.Fatalf("MKCOL: HTTP %d %s", status, reply)
	}
	paint := collection + "paint.ics"
	seed := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Itest//EN\r\nBEGIN:VTODO\r\nUID:paint@itest\r\n" +
		"DTSTAMP:20260101T000000Z\r\nSUMMARY:Paint the door\r\nPRIORITY:3\r\nCATEGORIES:home\r\nX-ITEST:keep\r\n" +
		"STATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
	if status, reply := server.dav(t, "PUT", paint, seed, map[string]string{"Content-Type": "text/calendar"}); status != 201 {
		t.Fatalf("seed: HTTP %d %s", status, reply)
	}
	get := func() string {
		t.Helper()
		status, body := server.dav(t, "GET", paint, "", nil)
		if status != 200 {
			t.Fatalf("GET: HTTP %d %s", status, body)
		}
		return body
	}

	found := callMap(t, sidecar, "tasks.caldavDiscover", map[string]any{"server": server.userURL(), "username": radicaleUser, "password": testPassword})
	var url string
	for _, item := range found["calendars"].([]any) {
		if str(item.(map[string]any), "name") == "Chores" {
			url = str(item.(map[string]any), "url")
		}
	}
	if url == "" {
		t.Fatalf("discover: %v", found)
	}
	added := callMap(t, sidecar, "tasks.caldavAdd", map[string]any{
		"url": url, "name": "Chores", "server": server.userURL(), "username": radicaleUser, "password": testPassword,
	})
	list := str(added, "id")

	tasks := func() map[string]map[string]any {
		t.Helper()
		out := map[string]map[string]any{}
		listed := callMap(t, sidecar, "tasks.list", map[string]any{"include_completed": true})
		for _, row := range listed["tasks"].([]any) {
			task := row.(map[string]any)
			if str(task, "list_id") == list {
				out[str(task, "title")] = task
			}
		}
		return out
	}
	syncList := func() map[string]any {
		t.Helper()
		result := callMap(t, sidecar, "tasks.sync", map[string]any{"list_id": list})
		lists := result["lists"].([]any)
		if len(lists) != 1 {
			t.Fatalf("sync: %v", result)
		}
		return lists[0].(map[string]any)
	}
	edit := func(task map[string]any, title string) {
		t.Helper()
		stored := callMap(t, sidecar, "tasks.get", map[string]any{"id": task["id"]})
		stored["title"] = title
		result := callMap(t, sidecar, "tasks.update", map[string]any{"id": task["id"], "revision": stored["revision"], "task": stored})
		if result["ok"] != true {
			t.Fatalf("update: %v", result)
		}
	}

	read := tasks()["Paint the door"]
	if read == nil || read["priority"] != float64(2) {
		t.Fatalf("first sync: %v", tasks())
	}

	t.Run("an edit here keeps what the other client wrote", func(t *testing.T) {
		edit(read, "Paint the front door")
		if result := syncList(); result["ok"] != true {
			t.Fatalf("sync: %v", result)
		}
		body := get()
		for _, want := range []string{"SUMMARY:Paint the front door", "PRIORITY:3", "CATEGORIES:home", "X-ITEST:keep", "UID:paint@itest"} {
			if !strings.Contains(body, want) {
				t.Fatalf("server lost %q:\n%s", want, body)
			}
		}
	})

	t.Run("an edit on both sides waits for a choice and writes nothing", func(t *testing.T) {
		body := get()
		elsewhere := strings.Replace(body, "SUMMARY:Paint the front door", "SUMMARY:Paint the back door", 1)
		if status, reply := server.dav(t, "PUT", paint, elsewhere, map[string]string{"Content-Type": "text/calendar"}); status >= 300 {
			t.Fatalf("change on the server: HTTP %d %s", status, reply)
		}
		edit(tasks()["Paint the front door"], "Paint the front door blue")
		if result := syncList(); result["ok"] != true {
			t.Fatalf("sync: %v", result)
		}
		task := tasks()["Paint the front door blue"]
		if task == nil || str(task, "conflict") != "changed" {
			t.Fatalf("want a conflict: %v", tasks())
		}
		if body := get(); !strings.Contains(body, "SUMMARY:Paint the back door") {
			t.Fatalf("nothing should have been written:\n%s", body)
		}
		callMap(t, sidecar, "tasks.resolveConflict", map[string]any{"id": task["id"], "keep": "mine"})
		if body := get(); !strings.Contains(body, "SUMMARY:Paint the front door blue") || !strings.Contains(body, "X-ITEST:keep") {
			t.Fatalf("mine should be on the server now:\n%s", body)
		}
		if task := tasks()["Paint the front door blue"]; str(task, "conflict") != "" || str(task, "pending") != "" {
			t.Fatalf("settled: %v", task)
		}
	})

	t.Run("a new task here is created there, and deleting the list leaves the server alone", func(t *testing.T) {
		callMap(t, sidecar, "tasks.create", map[string]any{"task": map[string]any{"list_id": list, "title": "Buy brushes", "priority": 1}})
		if result := syncList(); result["ok"] != true {
			t.Fatalf("sync: %v", result)
		}
		if task := tasks()["Buy brushes"]; task == nil || str(task, "pending") != "" {
			t.Fatalf("new task: %v", tasks())
		}
		callMap(t, sidecar, "tasks.deleteList", map[string]any{"id": list})
		report := `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>`
		status, body := server.dav(t, "REPORT", collection, report, map[string]string{"Content-Type": "application/xml", "Depth": "1"})
		if status != 207 || strings.Count(body, ".ics<") != 2 {
			t.Fatalf("both tasks stay on the server: HTTP %d\n%s", status, body)
		}
	})
}
