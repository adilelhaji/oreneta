package main

import (
	"testing"
	"time"
)

// captureNotifications swaps the platform dispatch for a recorder and a fixed
// clock, restoring both (and the quiet plan) when the test ends.
func captureNotifications(t *testing.T, now time.Time) *[]notification {
	t.Helper()
	var got []notification
	prevDispatch, prevNow := dispatchNotification, quietNow
	quietMu.Lock()
	prevPlan := currentQuiet
	quietMu.Unlock()
	dispatchNotification = func(_ *App, n notification) { got = append(got, n) }
	quietNow = func() time.Time { return now }
	t.Cleanup(func() {
		dispatchNotification, quietNow = prevDispatch, prevNow
		quietMu.Lock()
		currentQuiet = prevPlan
		quietMu.Unlock()
	})
	return &got
}

func TestParseQuietPlanDropsMalformedIntervals(t *testing.T) {
	plan := parseQuietPlan(map[string]any{
		"intervals": []any{
			[]any{float64(10), float64(20)},
			[]any{float64(30), float64(30)}, // empty
			[]any{"x", float64(40)},
			[]any{float64(50)},
			"nope",
		},
		"indefinite":          false,
		"remindersWhileQuiet": false,
		"quiet":               true,
	})
	if len(plan.intervals) != 1 || plan.intervals[0] != [2]int64{10, 20} {
		t.Fatalf("intervals = %v, want [[10 20]]", plan.intervals)
	}
	if plan.remindersWhileQuiet || !plan.quiet || plan.indefinite {
		t.Fatalf("flags = %+v", plan)
	}
	// Missing fields: nothing quiet, reminders allowed.
	empty := parseQuietPlan(map[string]any{})
	if empty.suppresses(quietMail, time.UnixMilli(15)) || !empty.remindersWhileQuiet {
		t.Fatalf("empty plan = %+v", empty)
	}
}

func TestQuietPlanSuppresses(t *testing.T) {
	plan := quietPlan{intervals: [][2]int64{{1000, 2000}}, remindersWhileQuiet: true}
	cases := []struct {
		ms   int64
		kind quietKind
		want bool
	}{
		{999, quietMail, false},
		{1000, quietMail, true},
		{1999, quietMail, true},
		{2000, quietMail, false}, // the end is open
		{1500, quietReminder, false},
	}
	for _, c := range cases {
		if got := plan.suppresses(c.kind, time.UnixMilli(c.ms)); got != c.want {
			t.Errorf("suppresses(%v, %d) = %v, want %v", c.kind, c.ms, got, c.want)
		}
	}
	plan.remindersWhileQuiet = false
	if !plan.suppresses(quietReminder, time.UnixMilli(1500)) {
		t.Error("a reminder must be held back when reminders are not allowed through")
	}
	if !(quietPlan{indefinite: true}).suppresses(quietMail, time.UnixMilli(0)) {
		t.Error("an open-ended pause holds mail back at any time")
	}
}

func TestQuietHoursGateNewMailAndReminders(t *testing.T) {
	now := time.UnixMilli(5_000)
	got := captureNotifications(t, now)
	a := &App{}
	mail := map[string]any{"account": "acc", "count": float64(1), "from": "Ana", "subject": "Hi"}
	reminder := map[string]any{"subject": "Stand-up", "start": float64(10)}
	task := map[string]any{"title": "Pay rent"}

	// Not quiet: everything goes through.
	a.handleSidecarEvent("mail.newMessages", mail)
	a.handleSidecarEvent("calendar.reminder", reminder)
	if len(*got) != 2 {
		t.Fatalf("not quiet: %d notifications, want 2", len(*got))
	}

	// Quiet now, reminders allowed (the default): mail is held back.
	if _, err := a.setNotifyQuiet(map[string]any{
		"intervals":           []any{[]any{float64(0), float64(10_000)}},
		"remindersWhileQuiet": true,
		"quiet":               true,
	}); err != nil {
		t.Fatal(err)
	}
	*got = nil
	a.handleSidecarEvent("mail.newMessages", mail)
	a.handleSidecarEvent("calendar.reminder", reminder)
	a.handleSidecarEvent("tasks.reminder", task)
	if len(*got) != 2 || (*got)[0].title != "Stand-up" || (*got)[1].title != "Pay rent" {
		t.Fatalf("quiet, reminders allowed: %+v", *got)
	}

	// Quiet, reminders not allowed: nothing.
	_, _ = a.setNotifyQuiet(map[string]any{"indefinite": true, "remindersWhileQuiet": false, "quiet": true})
	*got = nil
	a.handleSidecarEvent("mail.newMessages", mail)
	a.handleSidecarEvent("calendar.reminder", reminder)
	a.handleSidecarEvent("tasks.reminder", task)
	if len(*got) != 0 {
		t.Fatalf("quiet, reminders held: %+v", *got)
	}

	// The interval has passed: mail goes through again.
	_, _ = a.setNotifyQuiet(map[string]any{"intervals": []any{[]any{float64(0), float64(4_000)}}})
	a.handleSidecarEvent("mail.newMessages", mail)
	if len(*got) != 1 {
		t.Fatalf("after the interval: %d notifications, want 1", len(*got))
	}
}

// A reminder says its start on the clock the core read when it gave it
// (ADR-0056), which follows a change of zone; Go's own zone is read once.
func TestReminderShowsTheCoresLocalTime(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(0))
	a := &App{}
	start := float64(1_800_000_000)
	a.handleSidecarEvent("calendar.reminder", map[string]any{
		"subject": "Stand-up", "start": start, "location": "Room 2", "local_time": "09:00",
	})
	// From a core that does not say it: Go's clock, as before.
	a.handleSidecarEvent("calendar.reminder", map[string]any{"subject": "Old", "start": start})
	// An all-day event has no time to show.
	a.handleSidecarEvent("calendar.reminder", map[string]any{
		"subject": "Holiday", "start": start, "all_day": true, "location": "Home", "local_time": nil,
	})
	// Given late, after a sleep: it says the event started.
	a.handleSidecarEvent("calendar.reminder", map[string]any{
		"subject": "Review", "start": start, "local_time": "09:00", "started": true, "local_date": nil,
	})
	// Not today: the date comes first; an all-day event shows only its date.
	a.handleSidecarEvent("calendar.reminder", map[string]any{
		"subject": "Flight", "start": start, "local_time": "06:30", "local_date": "2026-10-21", "started": false,
	})
	a.handleSidecarEvent("calendar.reminder", map[string]any{
		"subject": "Trip", "start": start, "all_day": true, "local_time": nil, "local_date": "2026-10-21", "started": false,
	})
	want := []string{
		"09:00 · Room 2", time.Unix(int64(start), 0).Format("15:04"), "Home",
		"Started at 09:00", "2026-10-21 06:30", "2026-10-21",
	}
	if len(*got) != len(want) {
		t.Fatalf("%d notifications, want %d: %+v", len(*got), len(want), *got)
	}
	for i, body := range want {
		if (*got)[i].body != body {
			t.Errorf("notification %d body = %q, want %q", i, (*got)[i].body, body)
		}
	}

	// In the reader's language, as the frontend sets it.
	nativeLabelsMu.Lock()
	prev := currentLabels
	nativeLabelsMu.Unlock()
	t.Cleanup(func() {
		nativeLabelsMu.Lock()
		currentLabels = prev
		nativeLabelsMu.Unlock()
	})
	if _, err := a.setNativeLabels(map[string]any{"reminderStarted": "Empezó a las {time}"}); err != nil {
		t.Fatal(err)
	}
	*got = nil
	a.handleSidecarEvent("calendar.reminder", map[string]any{
		"subject": "Review", "start": start, "local_time": "09:00", "started": true, "location": "Sala 1",
	})
	if len(*got) != 1 || (*got)[0].body != "Empezó a las 09:00 · Sala 1" {
		t.Fatalf("translated: %+v", *got)
	}
}

func TestMutedAccountStillSilentWhenNotQuiet(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(0))
	(&App{}).handleSidecarEvent("mail.newMessages", map[string]any{"account": "acc", "muted": true})
	if len(*got) != 0 {
		t.Fatalf("muted account raised %+v", *got)
	}
}

func TestSetNotifyQuietRemembersTrayCheckBeforeTheTrayExists(t *testing.T) {
	captureNotifications(t, time.UnixMilli(0))
	trayMenuMu.Lock()
	prevItem, prevChecked := trayDndItem, trayDndChecked
	trayDndItem = nil
	trayMenuMu.Unlock()
	t.Cleanup(func() {
		trayMenuMu.Lock()
		trayDndItem, trayDndChecked = prevItem, prevChecked
		trayMenuMu.Unlock()
	})
	_, _ = (&App{}).setNotifyQuiet(map[string]any{"quiet": true})
	trayMenuMu.Lock()
	checked := trayDndChecked
	trayMenuMu.Unlock()
	if !checked {
		t.Fatal("the tray should start checked once it appears")
	}
}

func TestSetNativeLabelsAcceptsDoNotDisturb(t *testing.T) {
	nativeLabelsMu.Lock()
	prev := currentLabels
	nativeLabelsMu.Unlock()
	t.Cleanup(func() {
		nativeLabelsMu.Lock()
		currentLabels = prev
		nativeLabelsMu.Unlock()
	})
	a := &App{}
	if _, err := a.setNativeLabels(map[string]any{"trayDoNotDisturb": "No molestar"}); err != nil {
		t.Fatal(err)
	}
	if got := a.currentNativeLabels().trayDoNotDisturb; got != "No molestar" {
		t.Fatalf("trayDoNotDisturb = %q", got)
	}
}
