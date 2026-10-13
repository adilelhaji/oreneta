package jp.nonbili.meron.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import jp.nonbili.meron.shared.CalendarEvent
import jp.nonbili.meron.shared.CalendarEventDetails
import jp.nonbili.meron.shared.CalendarSummary

// What the Calendar destination shows; changed by MeronMobileState+Calendar.kt.

internal enum class EventDetailsState { Idle, Loading, Loaded, Failed }

internal class CalendarScreenState {
    var calendars by mutableStateOf(emptyList<CalendarSummary>())
    var events by mutableStateOf(emptyList<CalendarEvent>())
    var window by mutableStateOf<AgendaWindow?>(null)
    var loading by mutableStateOf(false)

    // The core answered that it has no calendar commands at all.
    var unavailable by mutableStateOf(false)
    var error by mutableStateOf("")

    // Background reads that failed, by account (pimSyncErrorsAfter): shown
    // above the agenda without hiding what the cache still holds.
    var syncErrors by mutableStateOf(emptyMap<String, String>())
    var calendarsOpen by mutableStateOf(false)
    var viewing by mutableStateOf<CalendarEvent?>(null)
    var viewingDetails by mutableStateOf<CalendarEventDetails?>(null)
    var detailsState by mutableStateOf(EventDetailsState.Idle)
    var editing by mutableStateOf<EventDraft?>(null)
    var editError by mutableStateOf("")
    var saving by mutableStateOf(false)
    var confirmingDelete by mutableStateOf<CalendarEvent?>(null)

    // Bumped per load, so a slow answer for a window the reader has already
    // left cannot replace the one on screen.
    var loadGeneration = 0
}
