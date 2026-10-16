package main

import (
	"sort"
	"strings"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Reminders missed while nobody looked (#225, ADR-0056). The core gathers a
// look's missed reminders into one `calendar.missedReminders` notice and
// records them as given, so the bridge must not lose it: the owner decided
// they must be shown. It is held, never dropped:
//
//   - at start, until the frontend has said the reader's language
//     (`setNativeLabels`) and the quiet plan (`notify.setQuiet`), or at most
//     missedStartupWait, so it speaks the reader's language and follows quiet
//     hours; the watch's first look comes before either;
//   - while quiet hours hold reminders back, until they end.
//
// Notices that arrive while one is held (an account connecting later, the
// next look) are merged into it by reminder key: one notification for them
// all, none twice.
//
// Holding in memory is not enough on its own: the app can quit or crash
// first. The core keeps every missed reminder until the bridge says it
// showed it (`reminders.missedShown` with the notice's `keys`) and says the
// notice again whenever it starts, so a held notice is not lost with the
// process, and once confirmed it is not said again.

// missedStartupWait is how long a notice waits at start for the language and
// the quiet plan before it goes with what the bridge has.
const missedStartupWait = 30 * time.Second

// missedRemindersShown is how many missed reminders the notification lists;
// the title says how many there were in all.
const missedRemindersShown = 5

// missedRemindersKept is how many details a held notice keeps, as many as the
// core sends (pim::reminders::MISSED_DETAILED).
const missedRemindersKept = 20

// calendarNotificationPrefix marks a notification target as a day of the
// calendar: "calendar:YYYY-MM-DD" opens its day view, "calendar:week:…" the
// week view of that day. The frontend reads it (openCalendarFromNotification).
const calendarNotificationPrefix = "calendar:"

// missedRemindersShownEvent tells the frontend the notice was shown, so it
// plays the reminder sound then, and not while the notice was held.
const missedRemindersShownEvent = "calendar.missedRemindersShown"

var (
	missedMu sync.Mutex
	// The notice held, merged; nil when none.
	missedHeld map[string]any
	// What the frontend has said since start.
	missedLabelsKnown, missedQuietKnown bool
	// The wait at start: begun with the first notice, over after
	// missedStartupWait.
	missedWaitBegun, missedWaitOver bool
	// The end of quiet hours a check is set for, so one is set per end.
	missedQuietCheck time.Time

	// missedAfter runs f after d; tests replace it to run the timers by hand.
	missedAfter = func(d time.Duration, f func()) { time.AfterFunc(d, f) }
	// emitToFrontend sends an event to the window; tests replace it.
	emitToFrontend = func(a *App, name string, detail any) {
		if a != nil && a.ctx != nil {
			wailsRuntime.EventsEmit(a.ctx, name, detail)
		}
	}
	// confirmMissedShown tells the core the notice holding keys was shown, off
	// the caller's goroutine; tests replace it. If it does not get through,
	// the core says the notice again at its next start: shown twice rather
	// than lost.
	confirmMissedShown = func(a *App, keys []any) {
		if a == nil || a.sidecar == nil {
			return
		}
		go func() {
			if _, err := a.sidecar.Call("reminders.missedShown", map[string]any{"keys": keys}); err != nil {
				a.logf("missed reminders shown, not confirmed to the core: %v", err)
			}
		}()
	}
)

// notifyMissedReminders takes a `calendar.missedReminders` notice from the
// core: held, merged with any notice already held, and shown as soon as it
// can be.
func (a *App) notifyMissedReminders(detail any) {
	m, ok := detail.(map[string]any)
	if !ok {
		return
	}
	if reminders, _ := m["reminders"].([]any); len(reminders) == 0 {
		return
	}
	missedMu.Lock()
	missedHeld = mergeMissedNotices(missedHeld, m)
	missedMu.Unlock()
	a.releaseMissedReminders()
}

// missedRemindersCanSpeak notes that the frontend said the reader's language.
func (a *App) missedRemindersCanSpeak() {
	missedMu.Lock()
	missedLabelsKnown = true
	missedMu.Unlock()
	a.releaseMissedReminders()
}

// missedRemindersKnowQuiet notes a new quiet plan: the first one ends the wait
// at start, and any one may end quiet hours.
func (a *App) missedRemindersKnowQuiet() {
	missedMu.Lock()
	missedQuietKnown = true
	missedMu.Unlock()
	a.releaseMissedReminders()
}

// releaseMissedReminders shows the held notice if nothing holds it any more,
// or sets a check for when the wait at start or quiet hours end.
func (a *App) releaseMissedReminders() {
	missedMu.Lock()
	if missedHeld == nil {
		missedMu.Unlock()
		return
	}
	if !(missedLabelsKnown && missedQuietKnown) && !missedWaitOver {
		if !missedWaitBegun {
			missedWaitBegun = true
			missedAfter(missedStartupWait, func() {
				missedMu.Lock()
				missedWaitOver = true
				missedMu.Unlock()
				a.releaseMissedReminders()
			})
		}
		missedMu.Unlock()
		return
	}
	quietMu.RLock()
	plan := currentQuiet
	quietMu.RUnlock()
	now := quietNow()
	if plan.suppresses(quietReminder, now) {
		// Until the end of quiet hours, if the plan says it; an open-ended
		// pause waits for the plan that ends it.
		if end, ok := plan.suppressedUntil(quietReminder, now); ok && !end.Equal(missedQuietCheck) {
			missedQuietCheck = end
			missedAfter(end.Sub(now), a.releaseMissedReminders)
		}
		missedMu.Unlock()
		return
	}
	notice := missedHeld
	missedHeld = nil
	missedMu.Unlock()
	a.showMissedReminders(notice)
}

// missedKey is a reminder's identity in a notice, its account and its key
// ("<event>@<start>"); empty from a core that does not say it.
func missedKey(item any) string {
	r, _ := item.(map[string]any)
	account, _ := r["account"].(string)
	key, _ := r["key"].(string)
	if key == "" {
		return ""
	}
	return account + "\x00" + key
}

// mergeMissedNotices adds notice to held, each reminder once by its key: the
// keys are the union of both and the count how many they are, the details
// are kept newest first by when their events start where the reader is
// (`at`, which puts an all-day event at its local midnight, not at the UTC
// one its stored `start` is), as many as missedRemindersKept, and the days
// span both.
func mergeMissedNotices(held, notice map[string]any) map[string]any {
	if held == nil {
		held = map[string]any{"keys": []any{}, "unkeyed": float64(0), "day": "", "first_day": "", "reminders": []any{}}
	}
	union := func(lists ...[]any) []any {
		var out []any
		seen := map[string]bool{}
		for _, list := range lists {
			for _, item := range list {
				id := missedKey(item)
				if id != "" && seen[id] {
					continue
				}
				seen[id] = true
				out = append(out, item)
			}
		}
		return out
	}
	heldKeys, _ := held["keys"].([]any)
	newKeys, hasKeys := notice["keys"].([]any)
	keys := union(heldKeys, newKeys)
	// A notice without keys (an older core) counts as it says.
	unkeyed, _ := held["unkeyed"].(float64)
	if !hasKeys {
		newReminders, _ := notice["reminders"].([]any)
		c, ok := notice["count"].(float64)
		if !ok || c < float64(len(newReminders)) {
			c = float64(len(newReminders))
		}
		unkeyed += c
	}
	heldReminders, _ := held["reminders"].([]any)
	newReminders, _ := notice["reminders"].([]any)
	reminders := union(heldReminders, newReminders)
	at := func(item any) float64 {
		r, _ := item.(map[string]any)
		if at, ok := r["at"].(float64); ok {
			return at
		}
		start, _ := r["start"].(float64)
		return start
	}
	sort.SliceStable(reminders, func(i, j int) bool { return at(reminders[i]) > at(reminders[j]) })
	if len(reminders) > missedRemindersKept {
		reminders = reminders[:missedRemindersKept]
	}
	day := func(m map[string]any, key string) string {
		value, _ := m[key].(string)
		return value
	}
	latest, first := day(held, "day"), day(held, "first_day")
	for _, candidate := range []string{day(notice, "day"), day(notice, "first_day")} {
		if candidate == "" {
			continue
		}
		if latest == "" || candidate > latest {
			latest = candidate
		}
		if first == "" || candidate < first {
			first = candidate
		}
	}
	return map[string]any{
		"count": float64(len(keys)) + unkeyed, "keys": keys, "unkeyed": unkeyed,
		"day": latest, "first_day": first, "reminders": reminders,
	}
}

// showMissedReminders raises the one notification for a notice: how many in
// the title, then when and what, newest first, one a line, and "…" when there
// were more. The subjects are other people's words (invitations): one line
// each and shown as text. Clicking it opens the calendar on the most recent
// missed day, in the week view when the misses span more than that day: the
// newest is the likeliest still to need something, and its week shows the
// others around it.
func (a *App) showMissedReminders(m map[string]any) {
	labels := a.currentNativeLabels()
	reminders, _ := m["reminders"].([]any)
	count := len(reminders)
	if c, ok := m["count"].(float64); ok && int(c) > count {
		count = int(c)
	}
	var lines []string
	account := ""
	for _, item := range reminders {
		r, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if account == "" {
			account, _ = r["account"].(string)
		}
		if len(lines) == missedRemindersShown {
			break
		}
		subject, _ := r["subject"].(string)
		subject = firstNonEmpty(notificationLine(subject, notificationTextMax), labels.noSubject)
		lines = append(lines, strings.TrimSpace(reminderWhen(r)+" "+subject))
	}
	if count > len(lines) {
		lines = append(lines, "…")
	}
	day, _ := m["day"].(string)
	firstDay, _ := m["first_day"].(string)
	target := calendarNotificationPrefix + day
	if firstDay != "" && firstDay != day {
		target = calendarNotificationPrefix + "week:" + day
	}
	dispatchNotification(a, notification{
		title:     formatNativePlural(labels.missedReminders, count),
		body:      strings.Join(lines, "\n"),
		account:   account,
		threadID:  target,
		plainBody: true,
	})
	emitToFrontend(a, missedRemindersShownEvent, map[string]any{"count": count})
	// Shown: the core may let these go and not say them again.
	if keys, _ := m["keys"].([]any); len(keys) > 0 {
		confirmMissedShown(a, keys)
	}
}
