package main

import (
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Do not disturb and quiet hours (ADR-0049). The frontend owns the rules — the
// pause, the weekly schedule, "Resume" — and pushes the result here as plain
// intervals (`notify.setQuiet`), recomputed whenever they change and hourly.
// The bridge only answers "is now inside one of them?", so the OS popups it
// raises follow the same decision as the UI without a second copy of the
// schedule, and keep doing so while the window's timers are throttled.

type quietKind int

const (
	quietMail quietKind = iota
	quietReminder
)

type quietPlan struct {
	// [start, end) in Unix milliseconds.
	intervals [][2]int64
	// A pause "until turned off".
	indefinite bool
	// Calendar and task reminders still show while quiet.
	remindersWhileQuiet bool
	// Whether it is quiet at the time of the push: drives the tray check mark.
	quiet bool
}

var (
	quietMu      sync.RWMutex
	currentQuiet = quietPlan{remindersWhileQuiet: true}
	// quietNow is the clock the gate reads; tests replace it.
	quietNow = time.Now
)

func parseQuietPlan(payload map[string]any) quietPlan {
	plan := quietPlan{remindersWhileQuiet: true}
	if v, ok := payload["indefinite"].(bool); ok {
		plan.indefinite = v
	}
	if v, ok := payload["remindersWhileQuiet"].(bool); ok {
		plan.remindersWhileQuiet = v
	}
	if v, ok := payload["quiet"].(bool); ok {
		plan.quiet = v
	}
	if list, ok := payload["intervals"].([]any); ok {
		for _, item := range list {
			pair, ok := item.([]any)
			if !ok || len(pair) != 2 {
				continue
			}
			start, okStart := pair[0].(float64)
			end, okEnd := pair[1].(float64)
			if !okStart || !okEnd || end <= start {
				continue
			}
			plan.intervals = append(plan.intervals, [2]int64{int64(start), int64(end)})
		}
	}
	return plan
}

// suppresses reports whether a notification of this kind is held back at now.
func (p quietPlan) suppresses(kind quietKind, now time.Time) bool {
	if kind == quietReminder && p.remindersWhileQuiet {
		return false
	}
	if p.indefinite {
		return true
	}
	ms := now.UnixMilli()
	for _, interval := range p.intervals {
		if interval[0] <= ms && ms < interval[1] {
			return true
		}
	}
	return false
}

func notificationsSuppressed(kind quietKind) bool {
	quietMu.RLock()
	plan := currentQuiet
	quietMu.RUnlock()
	return plan.suppresses(kind, quietNow())
}

func (a *App) setNotifyQuiet(payload map[string]any) (any, error) {
	plan := parseQuietPlan(payload)
	quietMu.Lock()
	currentQuiet = plan
	quietMu.Unlock()
	setTrayDoNotDisturbChecked(plan.quiet)
	return map[string]any{"ok": true}, nil
}

// toggleDoNotDisturbFromTray hands the click to the frontend, which owns the
// state and pushes the new plan (and so the check mark) back.
func (a *App) toggleDoNotDisturbFromTray() {
	ctx := a.runtimeContext()
	if ctx == nil {
		return
	}
	wailsRuntime.EventsEmit(ctx, "tray.doNotDisturb", map[string]any{})
}
