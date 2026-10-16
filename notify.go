package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

var (
	notifyIconOnce sync.Once
	notifyIconPath string
)

type nativeLabels struct {
	trayShow, trayHide, trayHideTooltip, trayQuit         string
	trayDoNotDisturb                                      string
	newMessage, newMessageCount, noSubject, unknownSender string
	reminderStarted, missedReminders                      string
}

var (
	nativeLabelsMu sync.RWMutex
	currentLabels  = nativeLabels{
		trayShow: "Show Oreneta", trayHide: "Hide to Tray",
		trayHideTooltip: "Hide Oreneta to the system tray", trayQuit: "Quit Oreneta",
		trayDoNotDisturb: "Do not disturb",
		newMessage:       "New message",
		newMessageCount:  "{count, plural, one {1 new message} other {{count} new messages}}",
		noSubject:        "(no subject)", unknownSender: "unknown sender",
		reminderStarted: "Started at {time}",
		missedReminders: "{count, plural, one {1 missed reminder} other {{count} missed reminders}}",
	}
)

func (a *App) currentNativeLabels() nativeLabels {
	nativeLabelsMu.RLock()
	defer nativeLabelsMu.RUnlock()
	return currentLabels
}

func (a *App) setNativeLabels(payload map[string]any) (any, error) {
	// Last, with every lock here released: a missed-reminders notice held
	// for the reader's language can go now (#225).
	defer a.missedRemindersCanSpeak()
	nativeLabelsMu.Lock()
	set := func(field *string, key string) {
		if value, ok := payload[key].(string); ok && value != "" {
			*field = value
		}
	}
	set(&currentLabels.trayShow, "trayShow")
	set(&currentLabels.trayHide, "trayHide")
	set(&currentLabels.trayHideTooltip, "trayHideTooltip")
	set(&currentLabels.trayQuit, "trayQuit")
	set(&currentLabels.trayDoNotDisturb, "trayDoNotDisturb")
	set(&currentLabels.newMessage, "newMessage")
	set(&currentLabels.newMessageCount, "newMessageCount")
	set(&currentLabels.noSubject, "noSubject")
	set(&currentLabels.unknownSender, "unknownSender")
	set(&currentLabels.reminderStarted, "reminderStarted")
	set(&currentLabels.missedReminders, "missedReminders")
	labels := currentLabels
	// Released before trayMenuMu is taken: trayReady holds trayMenuMu while it
	// reads the labels, so holding both here in the other order would deadlock.
	nativeLabelsMu.Unlock()
	trayMenuMu.Lock()
	defer trayMenuMu.Unlock()
	if trayShowItem != nil {
		trayShowItem.SetTitle(labels.trayShow)
		trayShowItem.SetTooltip(labels.trayShow)
	}
	if trayHideItem != nil {
		trayHideItem.SetTitle(labels.trayHide)
		trayHideItem.SetTooltip(labels.trayHideTooltip)
	}
	if trayQuitItem != nil {
		trayQuitItem.SetTitle(labels.trayQuit)
		trayQuitItem.SetTooltip(labels.trayQuit)
	}
	if trayDndItem != nil {
		trayDndItem.SetTitle(labels.trayDoNotDisturb)
		trayDndItem.SetTooltip(labels.trayDoNotDisturb)
	}
	return map[string]any{"ok": true}, nil
}

func formatNativePlural(template string, count int) string {
	selected := template
	if strings.HasPrefix(template, "{count, plural,") {
		branches := map[string]string{}
		for _, category := range []string{"one", "other"} {
			marker := category + " {"
			start := strings.Index(template, marker)
			if start < 0 {
				continue
			}
			start += len(marker)
			depth, end := 1, start
			for end < len(template) && depth > 0 {
				switch template[end] {
				case '{':
					depth++
				case '}':
					depth--
				}
				end++
			}
			if depth == 0 {
				branches[category] = template[start : end-1]
			}
		}
		if count == 1 {
			selected = branches["one"]
		} else {
			selected = branches["other"]
		}
	}
	return strings.ReplaceAll(selected, "{count}", fmt.Sprint(count))
}

// dispatchNotification hands a notification to the platform, off the caller's
// goroutine. A variable so tests can see what would have been raised.
var dispatchNotification = func(a *App, n notification) { go a.deliverNotification(n) }

// notification is the platform-agnostic payload a delivered OS notification
// carries. account/threadID are stashed so that clicking the notification can
// open the originating thread (see openThreadFromNotification).
type notification struct {
	title    string
	body     string
	account  string
	threadID string
	// plainBody marks a body written by someone else (a chat message): a
	// notification service that reads markup must show it as text.
	plainBody bool
}

// markupText escapes a plain text for a notification service that reads a
// small markup (freedesktop's body-markup), so `<b>` or `&` someone typed
// is shown, not obeyed.
func markupText(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// toastText keeps a text inside the CDATA section the Windows toast template
// puts it in: a "]]>" in it would end the section and let the rest be read
// as XML. It is split across two sections and shows unchanged.
func toastText(s string) string {
	return strings.ReplaceAll(s, "]]>", "]]]]><![CDATA[>")
}

// toastAttr escapes a value for an XML attribute of the Windows toast
// template, which inserts it as is; Windows hands it back unescaped.
func toastAttr(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;").Replace(s)
}

// notifyIcon writes the embedded app icon to a stable temp path the first time
// it is needed and returns that path. Windows notifications take an icon file
// path rather than raw bytes; an empty string falls back to no icon.
func notifyIcon() string {
	notifyIconOnce.Do(func() {
		if len(appIconPNG) == 0 {
			return
		}
		path := filepath.Join(os.TempDir(), "oreneta-notify.png")
		if err := os.WriteFile(path, appIconPNG, 0o644); err != nil {
			return
		}
		notifyIconPath = path
	})
	return notifyIconPath
}

// handleSidecarEvent runs for every event the mail engine pushes. It mirrors the
// event to the frontend already; here we layer on OS-level desktop notifications
// for newly arrived mail.
func (a *App) handleSidecarEvent(name string, detail any) {
	switch name {
	case "ready":
		a.checkProtocolVersion(detail)
		return
	case "core.fatal":
		a.recordCoreError(detail)
		return
	case "mail.syncError", "error":
		a.logSidecarError(name, detail)
		return
	case "mail.newMessages":
		a.notifyNewMail(detail)
	case "calendar.reminder":
		a.notifyReminder(detail)
	case "calendar.missedReminders":
		a.notifyMissedReminders(detail)
	case "tasks.reminder":
		a.notifyTaskReminder(detail)
	case "chat.notify":
		a.notifyChat(detail)
	}
}

// logSidecarError copies engine-side sync/generic failures into oreneta.log. The
// UI shows only a generic "unable to connect" banner, so without this the real
// cause (TLS, auth, timeout) reached the frontend and was thrown away, leaving
// nothing on disk to diagnose a failing account from.
func (a *App) logSidecarError(name string, detail any) {
	message, account := "", ""
	if m, ok := detail.(map[string]any); ok {
		message, _ = m["message"].(string)
		account, _ = m["account"].(string)
	}
	if message == "" {
		message = fmt.Sprint(detail)
	}
	if account != "" {
		a.logf("%s: account=%s %s", name, account, message)
		return
	}
	a.logf("%s: %s", name, message)
}

// recordCoreError logs the core's own fatal-condition report and keeps it for
// engineUnavailable. The event already reaches the frontend; dropping it here
// meant a core that could not open its store failed silently, leaving only
// per-call timeouts in the log.
func (a *App) recordCoreError(detail any) {
	message := ""
	if m, ok := detail.(map[string]any); ok {
		message, _ = m["message"].(string)
	}
	if message == "" {
		message = fmt.Sprint(detail)
	}
	a.logf("core error: %s", message)
	a.setCoreError(message)
}

// expectedProtocolVersion is the stdio protocol version this bridge speaks. It
// must stay in lockstep with PROTOCOL_VERSION in meron-core/src/main.rs.
const expectedProtocolVersion = 1

// checkProtocolVersion reads the protocol version off the sidecar's `ready`
// handshake and warns on absence or mismatch, so a version skew between the Go
// bridge and the Rust sidecar surfaces in the log instead of as silent breakage.
func (a *App) checkProtocolVersion(detail any) {
	m, ok := detail.(map[string]any)
	if !ok {
		a.logf("sidecar ready: missing protocol version (expected %d)", expectedProtocolVersion)
		return
	}
	v, ok := m["protocol"].(float64)
	if !ok {
		a.logf("sidecar ready: missing protocol version (expected %d)", expectedProtocolVersion)
		return
	}
	if int(v) != expectedProtocolVersion {
		a.logf("sidecar protocol mismatch: bridge=%d sidecar=%d", expectedProtocolVersion, int(v))
	}
}

// openThreadFromNotification is the single funnel every platform's click handler
// routes through: focus the window and tell the frontend which thread to open.
// The frontend (useAppEffects) keys off threadId/threadKey; account is passed for
// parity/future use.
func (a *App) openThreadFromNotification(account, threadID string) {
	if a == nil || a.ctx == nil {
		return
	}
	a.logf("notification clicked: account=%s, threadID=%s", account, threadID)
	a.showMainWindow()
	wailsRuntime.EventsEmit(a.ctx, "notification-clicked", map[string]string{
		"account":   account,
		"threadId":  threadID,
		"threadKey": threadID,
	})
}

func (a *App) notifyNewMail(detail any) {
	labels := a.currentNativeLabels()
	count := 1
	var account, accountName, folder, from, subject, preview, threadKey string
	if m, ok := detail.(map[string]any); ok {
		// Muted accounts still sync (the UI refreshes), they just don't raise an
		// OS notification. The sidecar resolves the mute pref onto each event.
		if muted, _ := m["muted"].(bool); muted {
			return
		}
	}
	// Do not disturb and quiet hours (ADR-0049): the unread badge still
	// updates (the frontend got the event), only the popup is held back.
	if notificationsSuppressed(quietMail) {
		return
	}
	if m, ok := detail.(map[string]any); ok {
		if c, ok := m["count"].(float64); ok && c > 0 {
			count = int(c)
		}
		account, _ = m["account"].(string)
		accountName, _ = m["accountName"].(string)
		folder, _ = m["folder"].(string)
		from, _ = m["from"].(string)
		subject, _ = m["subject"].(string)
		preview, _ = m["preview"].(string)
		threadKey, _ = m["threadKey"].(string)
	}

	if accountName == "" {
		accountName = account
	}

	// Title carries the most identifying info (sender for a single message,
	// otherwise the count) so the user can triage at a glance from the OS
	// notification list. Body adds the next layer (subject, account).
	var title, body string
	if count == 1 {
		title = firstNonEmpty(from, accountName, labels.newMessage)
		body = firstNonEmpty(subject, labels.noSubject)
		// The body snippet, when the sidecar managed to fetch it in time, so
		// the notification shows the mail itself and not just its subject.
		if preview != "" {
			body = fmt.Sprintf("%s — %s", body, preview)
		}
		if accountName != "" && title != accountName {
			title = fmt.Sprintf("%s - %s", title, accountName)
		}
	} else {
		title = formatNativePlural(labels.newMessageCount, count)
		if accountName != "" {
			title = fmt.Sprintf("%s - %s", title, accountName)
		}
		if from != "" || subject != "" {
			body = firstNonEmpty(from, labels.unknownSender)
			if subject != "" {
				body = fmt.Sprintf("%s — %s", body, subject)
			}
		}
	}

	n := notification{
		title:    title,
		body:     body,
		account:  account,
		threadID: notificationThreadID(account, folder, threadKey),
	}

	// Off the sidecar read loop: the platform notify call can block briefly and
	// must not stall event processing.
	dispatchNotification(a, n)
}

// notifyReminder raises the OS notification for a calendar reminder the core
// says has come due. The core decides when — it holds the events and the record
// of what has already been raised — so this only has to say it well.
func (a *App) notifyReminder(detail any) {
	m, ok := detail.(map[string]any)
	if !ok || notificationsSuppressed(quietReminder) {
		return
	}
	// Subject and place are someone else's words (an invitation's): one line
	// each, shown as text (plainBody), never read as markup.
	subject, _ := m["subject"].(string)
	location, _ := m["location"].(string)
	subject, location = notificationLine(subject, notificationTextMax), notificationLine(location, notificationTextMax)
	allDay, _ := m["all_day"].(bool)
	account, _ := m["account"].(string)
	started, _ := m["started"].(bool)
	labels := a.currentNativeLabels()

	if subject == "" {
		subject = labels.noSubject
	}

	// The body answers "when", which is the whole point of a reminder; the
	// place follows, since that is what decides whether to set off now. It
	// also says whether the event had already started, as one reminded late,
	// after a sleep, can have.
	body := reminderWhen(m)
	if started && !allDay && body != "" {
		body = strings.ReplaceAll(labels.reminderStarted, "{time}", body)
	}
	if location != "" {
		if body != "" {
			body += " · "
		}
		body += location
	}

	dispatchNotification(a, notification{
		title:     subject,
		body:      body,
		account:   account,
		plainBody: true,
	})
}

// reminderWhen is when a reminder's event starts, as a calendar.reminder
// detail says it. The core says the start on the clock of the zone the
// machine is in now (local_time, ADR-0056): Go reads its zone once, at
// start, so after a change of zone its own reading would be the old clock's.
// It also says the date when it is not today's (local_date).
func reminderWhen(m map[string]any) string {
	allDay, _ := m["all_day"].(bool)
	start, _ := m["start"].(float64)
	localTime, _ := m["local_time"].(string)
	localDate, _ := m["local_date"].(string)
	switch {
	case allDay:
		return localDate
	case localTime != "":
		return strings.TrimSpace(localDate + " " + localTime)
	case start > 0:
		return time.Unix(int64(start), 0).Format("15:04")
	}
	return ""
}

// notificationTextMax is how many characters of a text someone else wrote
// (an event's subject or place) a notification line shows.
const notificationTextMax = 80

// notificationLine fits a text someone else wrote to one line of a
// notification: control characters and runs of white space become one
// space, so a line break in a subject cannot fake further lines, and it is
// cut to max characters.
func notificationLine(s string, max int) string {
	words := strings.FieldsFunc(s, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
	runes := []rune(strings.Join(words, " "))
	if len(runes) > max {
		return string(runes[:max-1]) + "…"
	}
	return string(runes)
}

// notifyTaskReminder raises the OS notification for a task reminder
// (ADR-0013): the task's title, and its due date when it has one.
func (a *App) notifyTaskReminder(detail any) {
	m, ok := detail.(map[string]any)
	if !ok || notificationsSuppressed(quietReminder) {
		return
	}
	title, _ := m["title"].(string)
	if title == "" {
		title = a.currentNativeLabels().noSubject
	}
	var body string
	if due, ok := m["due_at"].(float64); ok && due > 0 {
		body = time.Unix(int64(due), 0).Format("2006-01-02")
	}
	dispatchNotification(a, notification{title: title, body: body})
}

// chatNotificationPrefix marks a notification target as a chat conversation
// rather than a mail thread; the frontend opens it in the Chat view.
const chatNotificationPrefix = "chat:"

// notifyChat raises the OS notification for a chat message the core says is
// worth one (ADR-0055): it already left out what was caught up on, rooms
// without a mention and a busy status. Do not disturb and quiet hours apply
// as for mail: a chat message is a message, not a reminder (ADR-0049).
func (a *App) notifyChat(detail any) {
	m, ok := detail.(map[string]any)
	if !ok || notificationsSuppressed(quietMail) {
		return
	}
	account, _ := m["account"].(string)
	conversation, _ := m["conversation"].(string)
	title, _ := m["title"].(string)
	body, _ := m["body"].(string)
	if account == "" || conversation == "" {
		return
	}
	dispatchNotification(a, notification{
		title:     firstNonEmpty(title, conversation),
		body:      body,
		account:   account,
		threadID:  chatNotificationPrefix + conversation,
		plainBody: true,
	})
}

func notificationThreadID(account, folder, threadKey string) string {
	if account == "" || threadKey == "" {
		return ""
	}
	if isRSSAccountID(account) {
		return fmt.Sprintf("%s#rss#%s", account, threadKey)
	}
	if folder == "" {
		folder = "INBOX"
	}
	// The sidecar already emits the branch-aware card key (subject branching
	// lives in the core), so this id lines up with the thread-list card the
	// user clicks. formatImapThreadID canonicalizes the folder casing
	// (inbox → INBOX) for the same reason.
	return formatImapThreadID(account, folder, threadKey)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
