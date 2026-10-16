package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// missedHold resets the missed-reminders hold for a test: whether the
// frontend has already said the language and the quiet plan (ready), the
// timers it sets (run by hand), and the events it sends the window.
type missedHold struct {
	timers    []time.Duration
	run       []func()
	emitted   []string
	confirmed [][]any
}

func holdMissed(t *testing.T, ready bool) *missedHold {
	t.Helper()
	h := &missedHold{}
	missedMu.Lock()
	prevHeld, prevLabels, prevQuiet := missedHeld, missedLabelsKnown, missedQuietKnown
	prevBegun, prevOver, prevCheck := missedWaitBegun, missedWaitOver, missedQuietCheck
	missedHeld, missedLabelsKnown, missedQuietKnown = nil, ready, ready
	missedWaitBegun, missedWaitOver, missedQuietCheck = false, false, time.Time{}
	missedMu.Unlock()
	prevAfter, prevEmit, prevConfirm := missedAfter, emitToFrontend, confirmMissedShown
	missedAfter = func(d time.Duration, f func()) {
		h.timers = append(h.timers, d)
		h.run = append(h.run, f)
	}
	emitToFrontend = func(_ *App, name string, _ any) { h.emitted = append(h.emitted, name) }
	confirmMissedShown = func(_ *App, keys []any) { h.confirmed = append(h.confirmed, keys) }
	nativeLabelsMu.Lock()
	prevLabelsText := currentLabels
	nativeLabelsMu.Unlock()
	t.Cleanup(func() {
		missedMu.Lock()
		missedHeld, missedLabelsKnown, missedQuietKnown = prevHeld, prevLabels, prevQuiet
		missedWaitBegun, missedWaitOver, missedQuietCheck = prevBegun, prevOver, prevCheck
		missedMu.Unlock()
		missedAfter, emitToFrontend, confirmMissedShown = prevAfter, prevEmit, prevConfirm
		nativeLabelsMu.Lock()
		currentLabels = prevLabelsText
		nativeLabelsMu.Unlock()
	})
	return h
}

// fire runs the last timer set.
func (h *missedHold) fire(t *testing.T) {
	t.Helper()
	if len(h.run) == 0 {
		t.Fatal("no timer was set")
	}
	f := h.run[len(h.run)-1]
	h.run = h.run[:len(h.run)-1]
	f()
}

// missedNotice is a calendar.missedReminders notice as the core sends it:
// count reminders, the first `details` of them detailed, newest first.
func missedNotice(count, details int, day, firstDay string) map[string]any {
	var reminders []any
	for i := 0; i < details; i++ {
		reminders = append(reminders, map[string]any{
			"account": "acc", "event": fmt.Sprint("e", i), "subject": fmt.Sprint("Meeting ", i),
			"start": float64(1_800_000_000 - i*3_600), "local_time": fmt.Sprintf("%02d:00", 20-i),
			"local_date": nil, "started": true,
		})
	}
	return map[string]any{"count": float64(count), "day": day, "first_day": firstDay, "reminders": reminders}
}

// One notification for a look's missed reminders (#225): how many in the
// title, when and what newest first one a line, "…" for the rest, and a click
// that opens the calendar on the most recent missed day: its day view, or
// its week when the misses span more days.
func TestMissedRemindersMakeOneNotificationThatOpensTheCalendar(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(5_000))
	h := holdMissed(t, true)
	a := &App{}

	notice := missedNotice(3, 2, "2026-10-20", "2026-10-19")
	reminders := notice["reminders"].([]any)
	reminders[1].(map[string]any)["local_date"] = "2026-10-19"
	notice["reminders"] = append(reminders, map[string]any{
		"account": "other", "event": "h", "subject": "", "start": float64(1), "all_day": true,
		"local_time": nil, "local_date": nil, "started": true,
	})
	a.handleSidecarEvent("calendar.missedReminders", notice)
	if len(*got) != 1 {
		t.Fatalf("%d notifications, want exactly one: %+v", len(*got), *got)
	}
	n := (*got)[0]
	if n.title != "3 missed reminders" || n.body != "20:00 Meeting 0\n2026-10-19 19:00 Meeting 1\n(no subject)" {
		t.Fatalf("missed notice: %+v", n)
	}
	if n.account != "acc" || n.threadID != "calendar:week:2026-10-20" || !n.plainBody {
		t.Fatalf("click target and text: %+v", n)
	}
	if len(h.emitted) != 1 || h.emitted[0] != missedRemindersShownEvent {
		t.Fatalf("the window hears it was shown, for its sound: %v", h.emitted)
	}

	// One day: its day view.
	*got = nil
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(1, 1, "2026-10-20", "2026-10-20"))
	if len(*got) != 1 || (*got)[0].title != "1 missed reminder" || (*got)[0].body != "20:00 Meeting 0" ||
		(*got)[0].threadID != "calendar:2026-10-20" {
		t.Fatalf("one missed: %+v", *got)
	}

	// Many: five lines, then an ellipsis; the title counts them all.
	*got = nil
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(7, 7, "2026-10-20", "2026-10-20"))
	if len(*got) != 1 || (*got)[0].title != "7 missed reminders" ||
		strings.Count((*got)[0].body, "\n") != missedRemindersShown || !strings.HasSuffix((*got)[0].body, "\n…") {
		t.Fatalf("seven missed: %+v", *got)
	}
	// The core details at most twenty: the count is the true one, and the
	// lines it has are followed by an ellipsis even when fewer than five.
	*got = nil
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(30, 3, "2026-10-20", "2026-10-18"))
	if len(*got) != 1 || (*got)[0].title != "30 missed reminders" ||
		(*got)[0].body != "20:00 Meeting 0\n19:00 Meeting 1\n18:00 Meeting 2\n…" {
		t.Fatalf("count above the details: %+v", *got)
	}

	// Nothing in it, or not an object: nothing raised, nothing held.
	*got = nil
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(0, 0, "", ""))
	a.handleSidecarEvent("calendar.missedReminders", "nope")
	if len(*got) != 0 || missedHeld != nil {
		t.Fatalf("empty notices raised %+v", *got)
	}

	// In the reader's language, as the frontend sets it.
	if _, err := a.setNativeLabels(map[string]any{
		"missedReminders": "{count, plural, one {1 aviso perdido} other {{count} avisos perdidos}}",
	}); err != nil {
		t.Fatal(err)
	}
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(2, 2, "2026-10-20", "2026-10-20"))
	if len(*got) != 1 || (*got)[0].title != "2 avisos perdidos" {
		t.Fatalf("translated: %+v", *got)
	}
}

// Someone else's subject is one line of text: a line break cannot fake
// another line (and get past the five-line cap), markup is not obeyed, and a
// long one is cut. The single reminder's subject and place too.
func TestMissedAndSingleRemindersShowSubjectsAsOneLineOfText(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(0))
	holdMissed(t, true)
	a := &App{}
	long := strings.Repeat("é", 100)
	notice := missedNotice(2, 2, "2026-10-20", "2026-10-20")
	reminders := notice["reminders"].([]any)
	reminders[0].(map[string]any)["subject"] = "Lunch\n09:00 Fake\r\n\t<b>bold</b>\u0000 & co"
	reminders[1].(map[string]any)["subject"] = long
	a.handleSidecarEvent("calendar.missedReminders", notice)
	want := "20:00 Lunch 09:00 Fake <b>bold</b> & co\n19:00 " + strings.Repeat("é", 79) + "…"
	if len(*got) != 1 || (*got)[0].body != want || !(*got)[0].plainBody {
		t.Fatalf("missed subjects: %q", (*got)[0].body)
	}

	*got = nil
	a.handleSidecarEvent("calendar.reminder", map[string]any{
		"subject": "Stand-up\nFake line", "location": "Room\n<i>2</i>", "local_time": "09:00", "start": float64(1),
	})
	if len(*got) != 1 || (*got)[0].title != "Stand-up Fake line" || (*got)[0].body != "09:00 · Room <i>2</i>" ||
		!(*got)[0].plainBody {
		t.Fatalf("single reminder: %+v", *got)
	}
	if notificationLine(long, notificationTextMax) != strings.Repeat("é", 79)+"…" || notificationLine("  ", 80) != "" {
		t.Fatal("notificationLine cuts by characters and drops blank text")
	}
}

// The owner decided missed reminders must be shown: quiet hours that hold
// reminders back defer the notice to their end, merging what comes meanwhile,
// rather than drop it (the core has recorded them as given).
func TestMissedRemindersWaitForQuietHoursToEnd(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(5_000))
	clock := time.UnixMilli(5_000)
	quietNow = func() time.Time { return clock }
	h := holdMissed(t, true)
	a := &App{}
	_, _ = a.setNotifyQuiet(map[string]any{
		"intervals":           []any{[]any{float64(0), float64(8_000)}, []any{float64(8_000), float64(10_000)}},
		"remindersWhileQuiet": false,
		"quiet":               true,
	})
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(2, 2, "2026-10-19", "2026-10-19"))
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(1, 1, "2026-10-20", "2026-10-20"))
	if len(*got) != 0 || len(h.emitted) != 0 {
		t.Fatalf("quiet: shown %+v", *got)
	}
	if len(h.timers) != 1 || h.timers[0] != 5_000*time.Millisecond {
		t.Fatalf("one check at the end of the joined quiet intervals: %v", h.timers)
	}
	clock = time.UnixMilli(10_000)
	h.fire(t)
	if len(*got) != 1 || (*got)[0].title != "3 missed reminders" || (*got)[0].threadID != "calendar:week:2026-10-20" {
		t.Fatalf("after quiet hours, one notice for both: %+v", *got)
	}

	// An open-ended pause: held until the plan that ends it.
	*got = nil
	_, _ = a.setNotifyQuiet(map[string]any{"indefinite": true, "remindersWhileQuiet": false, "quiet": true})
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(1, 1, "2026-10-20", "2026-10-20"))
	if len(*got) != 0 {
		t.Fatalf("paused: %+v", *got)
	}
	_, _ = a.setNotifyQuiet(map[string]any{"quiet": false})
	if len(*got) != 1 {
		t.Fatalf("resumed: %+v", *got)
	}

	// Quiet, but reminders allowed through: shown at once.
	*got = nil
	_, _ = a.setNotifyQuiet(map[string]any{"indefinite": true, "remindersWhileQuiet": true, "quiet": true})
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(1, 1, "2026-10-20", "2026-10-20"))
	if len(*got) != 1 {
		t.Fatalf("reminders allowed while quiet: %+v", *got)
	}
}

// At start the watch's first look comes before the frontend has said the
// language and the quiet plan: the notice waits for both (merging notices
// from accounts that connect meanwhile into one), or 30 seconds at most.
func TestMissedRemindersWaitAtStartForTheLanguageAndTheQuietPlan(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(5_000))
	h := holdMissed(t, false)
	a := &App{}
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(1, 1, "2026-10-20", "2026-10-20"))
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(2, 2, "2026-10-19", "2026-10-18"))
	if len(*got) != 0 || len(h.timers) != 1 || h.timers[0] != missedStartupWait {
		t.Fatalf("held at start, with one 30 s limit: %+v %v", *got, h.timers)
	}
	_, _ = a.setNativeLabels(map[string]any{
		"missedReminders": "{count, plural, one {1 aviso perdido} other {{count} avisos perdidos}}",
	})
	if len(*got) != 0 {
		t.Fatalf("still waiting for the quiet plan: %+v", *got)
	}
	_, _ = a.setNotifyQuiet(map[string]any{"quiet": false})
	if len(*got) != 1 || (*got)[0].title != "3 avisos perdidos" || (*got)[0].threadID != "calendar:week:2026-10-20" {
		t.Fatalf("one notice in the reader's language: %+v", *got)
	}
	h.fire(t) // The 30 s limit passing later changes nothing.
	if len(*got) != 1 {
		t.Fatalf("shown twice: %+v", *got)
	}
}

func TestMissedRemindersGoAfterThirtySecondsWithoutTheFrontend(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(5_000))
	h := holdMissed(t, false)
	a := &App{}
	a.handleSidecarEvent("calendar.missedReminders", missedNotice(1, 1, "2026-10-20", "2026-10-20"))
	if len(*got) != 0 {
		t.Fatalf("held: %+v", *got)
	}
	h.fire(t)
	if len(*got) != 1 || (*got)[0].title != "1 missed reminder" {
		t.Fatalf("after the wait, with what the bridge has: %+v", *got)
	}
}

// Languages with more plural forms than one/other (Polish, Arabic, Latvian)
// say the count without a plural, which the bridge fills in as it is.
func TestMissedRemindersTitleWithoutPluralForms(t *testing.T) {
	for template, want := range map[string]string{
		"Pominięte przypomnienia: {count}": "Pominięte przypomnienia: 3",
		"تذكيرات فائتة: {count}":           "تذكيرات فائتة: 11",
		"Nokavētie atgādinājumi: {count}":  "Nokavētie atgādinājumi: 21",
	} {
		count := map[string]int{"P": 3, "ت": 11, "N": 21}[string([]rune(template)[:1])]
		if got := formatNativePlural(template, count); got != want {
			t.Errorf("%q with %d = %q, want %q", template, count, got, want)
		}
	}
}

// keyed gives a notice the keys the core sends (#225 review): each detail's
// own and the notice's list of every one, here the details' only.
func keyed(notice map[string]any, prefix string) map[string]any {
	var keys []any
	for _, item := range notice["reminders"].([]any) {
		r := item.(map[string]any)
		r["key"] = prefix + r["event"].(string)
		keys = append(keys, map[string]any{"account": r["account"], "key": r["key"]})
	}
	notice["keys"] = keys
	return notice
}

// The core says a notice again at its next start until told it was shown,
// so a held notice is not lost if the app quits first: notices are merged
// by key (the same reminder twice is one line, counted once), and showing
// one confirms every key it held, so the core lets them go.
func TestMissedRemindersAreMergedByKeyAndConfirmedOnceShown(t *testing.T) {
	got := captureNotifications(t, time.UnixMilli(5_000))
	h := holdMissed(t, false)
	a := &App{}
	// Held at start; the core says the same two again (a restart of the
	// core), then one more.
	a.handleSidecarEvent("calendar.missedReminders", keyed(missedNotice(2, 2, "2026-10-20", "2026-10-20"), "k"))
	a.handleSidecarEvent("calendar.missedReminders", keyed(missedNotice(2, 2, "2026-10-20", "2026-10-20"), "k"))
	more := keyed(missedNotice(1, 1, "2026-10-21", "2026-10-21"), "new-")
	more["reminders"].([]any)[0].(map[string]any)["start"] = float64(1_800_100_000)
	a.handleSidecarEvent("calendar.missedReminders", more)
	if len(*got) != 0 || len(h.confirmed) != 0 {
		t.Fatalf("held, nothing confirmed: %+v %v", *got, h.confirmed)
	}
	_, _ = a.setNativeLabels(map[string]any{})
	_, _ = a.setNotifyQuiet(map[string]any{"quiet": false})
	// The newest (new-e0) first, then e0 and e1 once each, though said twice.
	if len(*got) != 1 || (*got)[0].title != "3 missed reminders" ||
		(*got)[0].body != "20:00 Meeting 0\n20:00 Meeting 0\n19:00 Meeting 1" {
		t.Fatalf("one notice, each reminder once: %+v", *got)
	}
	if len(h.confirmed) != 1 || len(h.confirmed[0]) != 3 {
		t.Fatalf("every key confirmed once: %v", h.confirmed)
	}
}

// Newest first is by when an event starts where the reader is (`at`): an
// all-day event's stored start is its UTC midnight, later than a meeting
// that starts after the local midnight east of UTC (#225 review).
func TestMergedMissedNoticesOrderByTheLocalStart(t *testing.T) {
	notice := map[string]any{"count": float64(2), "day": "2026-10-21", "first_day": "2026-10-21", "reminders": []any{
		// Tokyo: the 21st starts at 15:00Z on the 20th; stored at 00:00Z on the 21st.
		map[string]any{"account": "a", "key": "holiday@1792540800", "event": "holiday", "all_day": true,
			"start": float64(1_792_540_800), "at": float64(1_792_508_400)},
		// 05:00 on the 21st in Tokyo, 20:00Z on the 20th.
		map[string]any{"account": "a", "key": "early@1792526400", "event": "early",
			"start": float64(1_792_526_400), "at": float64(1_792_526_400)},
	}}
	merged := mergeMissedNotices(nil, notice)
	reminders := merged["reminders"].([]any)
	if reminders[0].(map[string]any)["event"] != "early" || reminders[1].(map[string]any)["event"] != "holiday" {
		t.Fatalf("newest by local start: %v", reminders)
	}
}

func TestMergedMissedNoticesKeepTheNewestTwentyAndSpanTheirDays(t *testing.T) {
	merged := mergeMissedNotices(nil, missedNotice(15, 15, "2026-10-19", "2026-10-18"))
	later := missedNotice(10, 10, "2026-10-21", "2026-10-20")
	for _, item := range later["reminders"].([]any) {
		r := item.(map[string]any)
		r["start"] = r["start"].(float64) + 86_400
		r["event"] = "later-" + r["event"].(string)
	}
	merged = mergeMissedNotices(merged, later)
	reminders := merged["reminders"].([]any)
	if merged["count"] != float64(25) || len(reminders) != missedRemindersKept ||
		merged["day"] != "2026-10-21" || merged["first_day"] != "2026-10-18" {
		t.Fatalf("merged: count=%v details=%d day=%v first=%v", merged["count"], len(reminders), merged["day"], merged["first_day"])
	}
	if reminders[0].(map[string]any)["event"] != "later-e0" || reminders[19].(map[string]any)["event"] != "e9" {
		t.Fatalf("newest first: %v … %v", reminders[0], reminders[19])
	}
}
