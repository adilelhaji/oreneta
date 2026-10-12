package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.CalendarCreateLocalParams
import jp.nonbili.meron.shared.CalendarCreateParams
import jp.nonbili.meron.shared.CalendarDeleteParams
import jp.nonbili.meron.shared.CalendarEvent
import jp.nonbili.meron.shared.CalendarEventDetailsParams
import jp.nonbili.meron.shared.CalendarEventsParams
import jp.nonbili.meron.shared.CalendarListParams
import jp.nonbili.meron.shared.CalendarSetEnabledParams
import jp.nonbili.meron.shared.CalendarSummary
import jp.nonbili.meron.shared.CalendarUpdateParams
import jp.nonbili.meron.shared.MobileCalendarCommandClient
import jp.nonbili.meron.shared.accountSummaryIsRss
import jp.nonbili.meron.shared.isUnknownCoreMethod
import jp.nonbili.meron.shared.ownAddressList
import jp.nonbili.meron.shared.parseCalendarEventDetailsResponse
import jp.nonbili.meron.shared.parseCalendarEventsResponse
import jp.nonbili.meron.shared.parseCalendarListResponse
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// The Calendar destination: the person's calendars and an agenda of their
// events, read and written through the same core commands as the desktop
// (frontend/src/states/calendar.ts). Mobile never tells anyone about a change
// and only ever changes one occurrence; events other people are on are left
// to the desktop, which can (see EventEditBlock).

private fun MeronMobileState.calendarClient() = MobileCalendarCommandClient(core)

private fun MeronMobileState.calendarAccountIds(): List<String> = coreAccounts.filterNot(::accountSummaryIsRss).map { it.id }

internal fun MeronMobileState.openCalendarScreen() {
    previousTopScreen = Screen.Calendar
    screen = Screen.Calendar
    loadCalendarScreen(refresh = true)
}

/** Reads the calendars and the agenda window, opening on today the first time. */
internal fun MeronMobileState.loadCalendarScreen(refresh: Boolean) {
    val ui = calendarUi
    if (!coreLoaded) {
        ui.error = coreUnavailableMessage
        return
    }
    val window = ui.window ?: agendaWindowFrom(currentTimeMillis() / 1000, ::localUtcOffsetSeconds).also { ui.window = it }
    val generation = ++ui.loadGeneration
    val accountIds = calendarAccountIds()
    val (from, to) = window.bounds(::localUtcOffsetSeconds)
    ui.loading = true
    ui.error = ""
    scope.launch {
        val calendars = mutableListOf<CalendarSummary>()
        val events = mutableListOf<CalendarEvent>()
        val failures = mutableListOf<Throwable>()
        withContext(ioDispatcher) {
            for (accountId in accountIds) {
                // One account failing must not blank the others, as on the desktop.
                runCatching {
                    calendars += parseCalendarListResponse(calendarClient().listCalendars(CalendarListParams(accountId)), accountId)
                    events += parseCalendarEventsResponse(calendarClient().events(CalendarEventsParams(accountId, from, to, refresh)), accountId)
                }.onFailure { failures += it }
            }
        }
        if (generation != ui.loadGeneration) return@launch
        ui.loading = false
        ui.unavailable = failures.any { isUnknownCoreMethod(it.message) }
        if (ui.unavailable) return@launch
        ui.calendars = calendars
        ui.events = events.sortedWith(compareBy<CalendarEvent>({ it.start }, { it.subject }))
        if (failures.isNotEmpty() && failures.size == accountIds.size) {
            ui.error = failures.first().message ?: trs("calendar.staleWarning")
        }
    }
}

/** A `calendar.synced` event: the core refreshed behind an earlier read. */
internal fun MeronMobileState.reloadCalendarAfterSync() {
    if (screen == Screen.Calendar && !calendarUi.loading) loadCalendarScreen(refresh = false)
}

internal fun MeronMobileState.moveCalendarWindow(forward: Boolean) {
    val window = calendarUi.window ?: return
    calendarUi.window = if (forward) window.next() else window.previous()
    loadCalendarScreen(refresh = true)
}

internal fun MeronMobileState.showCalendarToday() {
    calendarUi.window = agendaWindowFrom(currentTimeMillis() / 1000, ::localUtcOffsetSeconds)
    loadCalendarScreen(refresh = true)
}

/**
 * Adds a calendar kept on this phone. A fresh install has none, and without
 * one there is nowhere to put an event. It goes under the first mail
 * account, as the desktop files local calendars under an account.
 */
internal fun MeronMobileState.addLocalCalendar(name: String) {
    val ui = calendarUi
    val accountId = calendarAccountIds().firstOrNull()
    if (name.isBlank() || accountId == null) return
    scope.launch {
        runCatching {
            withContext(ioDispatcher) { calendarClient().createLocal(CalendarCreateLocalParams(accountId, name.trim())) }
        }.onSuccess {
            loadCalendarScreen(refresh = false)
        }.onFailure {
            ui.error = it.message.orEmpty()
        }
    }
}

/** Shows or hides one calendar. Hiding never forgets it. */
internal fun MeronMobileState.setCalendarShown(
    calendar: CalendarSummary,
    shown: Boolean,
) {
    val ui = calendarUi
    scope.launch {
        runCatching {
            withContext(ioDispatcher) {
                calendarClient().setEnabled(CalendarSetEnabledParams(calendar.accountId, calendar.id, shown))
            }
        }.onSuccess {
            ui.calendars = ui.calendars.map { if (it.accountId == calendar.accountId && it.id == calendar.id) it.copy(enabled = shown) else it }
            // A calendar shown again has nothing cached; ask for its events.
            if (shown) loadCalendarScreen(refresh = true)
        }.onFailure {
            ui.error = it.message.orEmpty()
        }
    }
}

/**
 * Opens an event. Who is on it and its notes are read separately when the
 * window could not carry them (Exchange's never does), and until they are
 * known the event cannot be changed here.
 */
internal fun MeronMobileState.openCalendarEvent(event: CalendarEvent) {
    val ui = calendarUi
    ui.viewing = event
    ui.viewingDetails = null
    val calendar = calendarOf(event, ui.calendars)
    if (attendeesComeWithWindow(calendar)) {
        ui.detailsState = EventDetailsState.Loaded
        return
    }
    ui.detailsState = EventDetailsState.Loading
    scope.launch {
        runCatching {
            withContext(ioDispatcher) {
                calendarClient().eventDetails(
                    CalendarEventDetailsParams(event.accountId, event.calendarId, event.id, event.changeKey.orEmpty()),
                )
            }
        }.onSuccess { response ->
            if (ui.viewing?.id != event.id) return@onSuccess
            ui.viewingDetails = parseCalendarEventDetailsResponse(response)
            ui.detailsState = EventDetailsState.Loaded
        }.onFailure {
            if (ui.viewing?.id == event.id) ui.detailsState = EventDetailsState.Failed
        }
    }
}

internal fun MeronMobileState.closeCalendarEvent() {
    calendarUi.viewing = null
    calendarUi.viewingDetails = null
    calendarUi.detailsState = EventDetailsState.Idle
}

/** Why the open event cannot be changed here, if it cannot. */
internal fun MeronMobileState.calendarEditBlock(event: CalendarEvent): EventEditBlock {
    val ui = calendarUi
    val calendar = calendarOf(event, ui.calendars)
    val known = attendeesComeWithWindow(calendar) || ui.detailsState == EventDetailsState.Loaded
    return mobileEditBlock(
        event = event,
        calendar = calendar,
        attendeesKnown = known,
        attendees = ui.viewingDetails?.attendees.orEmpty(),
        ownAddresses = ownAddressList(coreAccounts).toSet(),
    )
}

internal fun MeronMobileState.startNewCalendarEvent() {
    val draft = newEventDraft(calendarUi.calendars, currentTimeMillis() / 1000) ?: return
    calendarUi.editError = ""
    calendarUi.editing = draft
}

internal fun MeronMobileState.startEditingCalendarEvent(event: CalendarEvent) {
    if (calendarEditBlock(event) != EventEditBlock.None) return
    calendarUi.editError = ""
    calendarUi.editing = editDraftOf(event, calendarUi.viewingDetails?.description)
    closeCalendarEvent()
}

/** Creates or updates the open draft; on failure the editor stays open with what was typed. */
internal fun MeronMobileState.saveCalendarDraft() {
    val ui = calendarUi
    val draft = ui.editing ?: return
    draft.problemKey()?.let {
        ui.editError = trs(it)
        return
    }
    ui.saving = true
    ui.editError = ""
    scope.launch {
        runCatching {
            withContext(ioDispatcher) {
                val event = draft.toEvent()
                if (draft.isNew) calendarClient().create(CalendarCreateParams(event)) else calendarClient().update(CalendarUpdateParams(event))
            }
        }.onSuccess {
            ui.saving = false
            ui.editing = null
            loadCalendarScreen(refresh = false)
        }.onFailure {
            ui.saving = false
            ui.editError = it.message.orEmpty()
        }
    }
}

/** Deletes one occurrence. Nobody is told. */
internal fun MeronMobileState.deleteCalendarEvent(event: CalendarEvent) {
    val ui = calendarUi
    ui.confirmingDelete = null
    scope.launch {
        runCatching {
            withContext(ioDispatcher) { calendarClient().delete(CalendarDeleteParams(event)) }
        }.onSuccess {
            closeCalendarEvent()
            ui.events = ui.events.filterNot { it.accountId == event.accountId && it.id == event.id }
            loadCalendarScreen(refresh = false)
        }.onFailure {
            ui.error = it.message.orEmpty()
        }
    }
}
