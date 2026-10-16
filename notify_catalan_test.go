package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// catalanNativeLabels is what the frontend sends to i18n.setNativeLabels when
// the interface is in Catalan (#231, ADR-0062): the same catalog keys as
// nativeLabels() in frontend/src/states/interfaceLanguage.ts, read from the
// shipped catalog, so a translation Go cannot use fails here.
func catalanNativeLabels(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("locales/ca.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog map[string]string
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	keys := map[string]string{
		"trayShow":         "tray.showOreneta",
		"trayHide":         "tray.hideToTray",
		"trayHideTooltip":  "tray.hideOrenetaTooltip",
		"trayQuit":         "tray.quitOreneta",
		"trayDoNotDisturb": "tray.doNotDisturb",
		"newMessage":       "notify.newMessage",
		"newMessageCount":  "notify.newMessageCount",
		"noSubject":        "notify.noSubject",
		"unknownSender":    "notify.unknownSender",
		"reminderStarted":  "notify.reminderStarted",
		"missedReminders":  "notify.missedReminders",
	}
	payload := map[string]any{}
	for field, key := range keys {
		value, ok := catalog[key]
		if !ok || value == "" {
			t.Fatalf("ca.json has no %s", key)
		}
		payload[field] = value
	}
	return payload
}

func keepNativeLabels(t *testing.T) {
	t.Helper()
	nativeLabelsMu.Lock()
	prev := currentLabels
	nativeLabelsMu.Unlock()
	t.Cleanup(func() {
		nativeLabelsMu.Lock()
		currentLabels = prev
		nativeLabelsMu.Unlock()
	})
}

func TestNativeLabelsArriveInCatalan(t *testing.T) {
	keepNativeLabels(t)
	a := &App{}
	if _, err := a.setNativeLabels(catalanNativeLabels(t)); err != nil {
		t.Fatal(err)
	}
	labels := a.currentNativeLabels()
	for got, want := range map[string]string{
		labels.trayShow:         "Mostra Oreneta",
		labels.trayHide:         "Amaga a la safata",
		labels.trayQuit:         "Surt d'Oreneta",
		labels.trayDoNotDisturb: "No molestis",
	} {
		if got != want {
			t.Errorf("tray label %q, want %q", got, want)
		}
	}
	// The plural templates are ones Go's own reader picks a branch from.
	for count, want := range map[int]string{1: "1 recordatori perdut", 4: "4 recordatoris perduts"} {
		if got := formatNativePlural(labels.missedReminders, count); got != want {
			t.Errorf("missed reminders (%d) = %q, want %q", count, got, want)
		}
	}
}

func TestNotificationsSpeakCatalan(t *testing.T) {
	keepNativeLabels(t)
	got := captureNotifications(t, time.UnixMilli(0))
	a := &App{}
	if _, err := a.setNativeLabels(catalanNativeLabels(t)); err != nil {
		t.Fatal(err)
	}

	a.handleSidecarEvent("mail.newMessages", map[string]any{"account": "Feina", "count": float64(3), "subject": "Pressupost"})
	a.handleSidecarEvent("mail.newMessages", map[string]any{"account": "Feina", "count": float64(1), "from": "Anna"})
	a.handleSidecarEvent("calendar.reminder", map[string]any{
		"subject": "", "start": float64(1_800_000_000), "local_time": "09:00", "started": true, "location": "Sala 1",
	})
	want := []notification{
		{title: "3 missatges nous - Feina", body: "remitent desconegut — Pressupost"},
		{title: "Anna - Feina", body: "(sense assumpte)"},
		{title: "(sense assumpte)", body: "Ha començat a les 09:00 · Sala 1"},
	}
	if len(*got) != len(want) {
		t.Fatalf("%d notifications, want %d: %+v", len(*got), len(want), *got)
	}
	for i, w := range want {
		n := (*got)[i]
		if n.title != w.title || n.body != w.body {
			t.Errorf("notification %d = %q / %q, want %q / %q", i, n.title, n.body, w.title, w.body)
		}
		if strings.ContainsAny(n.title+n.body, "{}") {
			t.Errorf("notification %d kept ICU syntax: %q / %q", i, n.title, n.body)
		}
	}
}
