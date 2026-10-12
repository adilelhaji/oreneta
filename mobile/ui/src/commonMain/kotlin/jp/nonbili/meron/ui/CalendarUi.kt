package jp.nonbili.meron.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Today
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.nonbili.meron.shared.CalendarEvent
import jp.nonbili.meron.shared.CalendarParticipant
import jp.nonbili.meron.shared.CalendarSummary

// The Calendar destination's screens: an agenda of a fortnight at a time,
// the calendars to show, an event's details, and the editor. State lives in
// CalendarScreenState and every action goes through the callbacks, which
// MeronMobileState+Calendar.kt provides (see PimRoutesUi.kt).

internal class CalendarActions(
    val onOpenDrawer: () -> Unit,
    val onToday: () -> Unit,
    val onMoveWindow: (forward: Boolean) -> Unit,
    val onRefresh: () -> Unit,
    val onSetCalendarShown: (CalendarSummary, Boolean) -> Unit,
    val onAddCalendar: (name: String) -> Unit,
    val onNewEvent: () -> Unit,
    val onOpenEvent: (CalendarEvent) -> Unit,
    val onCloseEvent: () -> Unit,
    val editBlock: (CalendarEvent) -> EventEditBlock,
    val onEditEvent: (CalendarEvent) -> Unit,
    val onSaveDraft: () -> Unit,
    val onDeleteEvent: (CalendarEvent) -> Unit,
    val onOpenUrl: (String) -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CalendarScreen(
    ui: CalendarScreenState,
    drawerState: DrawerState,
    drawerContent: @Composable () -> Unit,
    actions: CalendarActions,
) {
    val offsetAt: UtcOffsetAt = ::localUtcOffsetSeconds
    ModalNavigationDrawer(drawerState = drawerState, drawerContent = drawerContent) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(tr("calendar.title")) },
                    navigationIcon = {
                        IconButton(onClick = actions.onOpenDrawer) {
                            Icon(Icons.Filled.Menu, contentDescription = tr("mobile.actions.openNavigation"))
                        }
                    },
                    actions = {
                        if (!ui.unavailable) {
                            IconButton(onClick = actions.onToday) {
                                Icon(Icons.Filled.Today, contentDescription = tr("calendar.today"))
                            }
                            IconButton(onClick = { ui.calendarsOpen = true }) {
                                Icon(Icons.Filled.Tune, contentDescription = tr("mobile.calendar.calendars"))
                            }
                        }
                        IconButton(onClick = actions.onRefresh) {
                            Icon(Icons.Filled.Refresh, contentDescription = tr("mobile.actions.refresh"))
                        }
                    },
                )
            },
            floatingActionButton = {
                if (!ui.unavailable && writableCalendars(ui.calendars).isNotEmpty()) {
                    ExtendedFloatingActionButton(
                        onClick = actions.onNewEvent,
                        icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                        text = { Text(tr("calendar.newEvent")) },
                    )
                }
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                if (ui.unavailable) {
                    EmptyState(Icons.Filled.CalendarMonth, tr("calendar.title"), tr("mobile.calendar.unavailable"))
                    return@Column
                }
                if (ui.error.isNotBlank()) {
                    StatusBanner(
                        message = ui.error,
                        isError = true,
                        actionLabel = tr("calendar.retry"),
                        onAction = actions.onRefresh,
                        onDismiss = { ui.error = "" },
                    )
                }
                val window = ui.window
                if (window != null) {
                    WindowBar(window, offsetAt, actions.onMoveWindow)
                }
                val days =
                    remember(ui.events, ui.calendars, window) {
                        if (window == null) emptyList() else groupAgenda(ui.events, window, offsetAt, ui.calendars)
                    }
                when {
                    ui.loading && ui.events.isEmpty() -> {
                        LoadingState(tr("common.loading"))
                    }

                    ui.calendars.isEmpty() && !ui.loading -> {
                        EmptyState(Icons.Filled.CalendarMonth, tr("calendar.title"), tr("calendar.noCalendars"))
                    }

                    days.isEmpty() -> {
                        EmptyState(Icons.Filled.CalendarMonth, tr("calendar.title"), tr("calendar.empty"))
                    }

                    else -> {
                        AgendaList(days, ui.calendars, offsetAt, actions.onOpenEvent)
                    }
                }
            }
        }
    }

    if (ui.calendarsOpen) {
        CalendarsDialog(
            ui.calendars,
            onSetShown = actions.onSetCalendarShown,
            onAdd = actions.onAddCalendar,
            onDismiss = { ui.calendarsOpen = false },
        )
    }
    ui.viewing?.let { event ->
        EventDetailsDialog(ui, event, offsetAt, actions)
    }
    ui.editing?.let { draft ->
        EventEditorDialog(
            draft = draft,
            calendars = ui.calendars,
            saving = ui.saving,
            error = ui.editError,
            offsetAt = offsetAt,
            onChange = { ui.editing = it },
            onSave = actions.onSaveDraft,
            onDismiss = {
                if (!ui.saving) ui.editing = null
            },
        )
    }
    ui.confirmingDelete?.let { event ->
        AlertDialog(
            onDismissRequest = { ui.confirmingDelete = null },
            title = { Text(tr("mobile.calendar.deleteTitle")) },
            text = {
                Text(
                    listOfNotNull(
                        event.subject.ifBlank { tr("calendar.noSubject") },
                        tr("mobile.calendar.occurrenceOnly").takeIf { event.isRecurring },
                    ).joinToString("\n\n"),
                )
            },
            confirmButton = {
                TextButton(onClick = { actions.onDeleteEvent(event) }) {
                    Text(tr("calendar.delete"), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { ui.confirmingDelete = null }) { Text(tr("buttons.cancel")) }
            },
        )
    }
}

@Composable
private fun WindowBar(
    window: AgendaWindow,
    offsetAt: UtcOffsetAt,
    onMove: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = { onMove(false) }) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = tr("calendar.previousPeriod"))
        }
        Text(
            "${shortDate(window.startDay, offsetAt)} – ${shortDate(window.endDayExclusive - 1, offsetAt)}",
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.weight(1f),
            maxLines = 1,
        )
        IconButton(onClick = { onMove(true) }) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = tr("calendar.nextPeriod"))
        }
    }
}

@Composable
private fun AgendaList(
    days: List<AgendaDay>,
    calendars: List<CalendarSummary>,
    offsetAt: UtcOffsetAt,
    onOpen: (CalendarEvent) -> Unit,
) {
    val today = localEpochDay(currentTimeMillis() / 1000, offsetAt)
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        for (day in days) {
            item(key = "day-${day.epochDay}") {
                Text(
                    dayHeading(day.epochDay, today, offsetAt),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = if (day.epochDay == today) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp),
                )
            }
            items(day.events, key = { "${day.epochDay}-${it.accountId}-${it.id}" }) { event ->
                AgendaRow(event, calendarOf(event, calendars), offsetAt, onClick = { onOpen(event) })
            }
        }
    }
}

@Composable
private fun AgendaRow(
    event: CalendarEvent,
    calendar: CalendarSummary?,
    offsetAt: UtcOffsetAt,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier
                .width(4.dp)
                .height(36.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(calendarColor(calendar) ?: MaterialTheme.colorScheme.primary),
        )
        Column(Modifier.weight(1f)) {
            Text(
                event.subject.ifBlank { tr("calendar.noSubject") },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = if (event.isCancelled) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            )
            val place = event.location?.takeIf { it.isNotBlank() }
            Text(
                listOfNotNull(timeLabel(event), place).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun CalendarsDialog(
    calendars: List<CalendarSummary>,
    onSetShown: (CalendarSummary, Boolean) -> Unit,
    onAdd: (name: String) -> Unit,
    onDismiss: () -> Unit,
) {
    var newName by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(tr("mobile.calendar.calendars")) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    tr("calendar.settingsHint"),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                if (calendars.isEmpty()) Text(tr("calendar.noCalendars"))
                for (calendar in calendars) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Box(
                            Modifier.size(12.dp).clip(RoundedCornerShape(6.dp)).background(
                                calendarColor(calendar) ?: MaterialTheme.colorScheme.primary,
                            ),
                        )
                        Text(calendar.name, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (calendar.readOnly || calendar.kind == "subscribed") {
                            Icon(Icons.Filled.Lock, contentDescription = tr("calendar.readOnly"), modifier = Modifier.size(16.dp))
                        }
                        Switch(checked = calendar.enabled, onCheckedChange = { onSetShown(calendar, it) })
                    }
                }
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = newName,
                        onValueChange = { newName = it },
                        label = { Text(tr("calendar.newCalendarName")) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        enabled = newName.isNotBlank(),
                        onClick = {
                            onAdd(newName)
                            newName = ""
                        },
                    ) { Text(tr("calendar.addCalendar")) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(tr("buttons.done")) } },
    )
}

@Composable
private fun EventDetailsDialog(
    ui: CalendarScreenState,
    event: CalendarEvent,
    offsetAt: UtcOffsetAt,
    actions: CalendarActions,
) {
    val calendar = calendarOf(event, ui.calendars)
    val block = actions.editBlock(event)
    val details = ui.viewingDetails
    val attendees = details?.attendees?.takeIf { it.isNotEmpty() } ?: event.attendees
    val description = event.description.ifBlank { details?.description.orEmpty() }
    AlertDialog(
        onDismissRequest = actions.onCloseEvent,
        title = { Text(event.subject.ifBlank { tr("calendar.noSubject") }) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(fullTimeLabel(event, offsetAt), style = MaterialTheme.typography.bodyMedium)
                if (event.isRecurring) DetailNote(tr("calendar.recurring"))
                calendar?.let {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(calendarColor(it) ?: MaterialTheme.colorScheme.primary))
                        Text(it.name, style = MaterialTheme.typography.bodySmall)
                        if (it.readOnly || it.kind == "subscribed") {
                            Icon(Icons.Filled.Lock, contentDescription = tr("calendar.readOnly"), modifier = Modifier.size(14.dp))
                        }
                    }
                }
                event.location?.takeIf { it.isNotBlank() }?.let { DetailField(tr("calendar.location"), it) }
                event.meeting?.let { meeting ->
                    OutlinedButton(onClick = { actions.onOpenUrl(meeting.url) }) {
                        Text(tr("calendar.join", mapOf("name" to meetingName(meeting.provider))))
                    }
                }
                event.organizer?.takeIf { it.addr.isNotBlank() || it.name.isNotBlank() }?.let {
                    DetailField(tr("calendar.organizer"), participantLabel(it))
                }
                if (attendees.isNotEmpty()) {
                    val lines =
                        attendees.map { person ->
                            val answer = responseLabel(person.response)
                            if (answer == null) participantLabel(person) else "${participantLabel(person)} · $answer"
                        }
                    DetailField(tr("mobile.calendar.guests"), lines.joinToString("\n"))
                }
                if (description.isNotBlank()) DetailField(tr("calendar.description"), description)
                when (block) {
                    EventEditBlock.None -> {}

                    EventEditBlock.ReadOnly -> {
                        DetailNote(tr("calendar.readOnlyEvent"))
                    }

                    EventEditBlock.Guests -> {
                        DetailNote(tr("mobile.calendar.guestsReadOnly"))
                    }

                    EventEditBlock.GuestsUnknown -> {
                        if (ui.detailsState == EventDetailsState.Loading) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            DetailNote(tr("mobile.calendar.guestsUnknown"))
                        }
                    }
                }
            }
        },
        confirmButton = {
            Row {
                if (block == EventEditBlock.None) {
                    TextButton(onClick = { ui.confirmingDelete = event }) {
                        Text(tr("calendar.delete"), color = MaterialTheme.colorScheme.error)
                    }
                    TextButton(onClick = { actions.onEditEvent(event) }) { Text(tr("calendar.editEvent")) }
                }
                TextButton(onClick = actions.onCloseEvent) { Text(tr("calendar.close")) }
            }
        },
    )
}

@Composable
private fun DetailField(
    label: String,
    value: String,
) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun DetailNote(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

private enum class PickerTarget { StartDate, StartTime, EndDate, EndTime }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EventEditorDialog(
    draft: EventDraft,
    calendars: List<CalendarSummary>,
    saving: Boolean,
    error: String,
    offsetAt: UtcOffsetAt,
    onChange: (EventDraft) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    var picker by remember { mutableStateOf<PickerTarget?>(null) }
    var calendarMenuOpen by remember { mutableStateOf(false) }
    val writable = writableCalendars(calendars)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (draft.isNew) tr("calendar.newEvent") else tr("calendar.editEvent")) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OutlinedTextField(
                    value = draft.subject,
                    onValueChange = { onChange(draft.copy(subject = it)) },
                    label = { Text(tr("calendar.subject")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                // An existing event stays on its calendar, as on the desktop.
                if (draft.isNew && writable.size > 1) {
                    Box {
                        OutlinedButton(onClick = { calendarMenuOpen = true }, modifier = Modifier.fillMaxWidth()) {
                            val current = writable.find { it.accountId == draft.accountId && it.id == draft.calendarId }
                            Text("${tr("calendar.calendar")}: ${current?.name.orEmpty()}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        DropdownMenu(expanded = calendarMenuOpen, onDismissRequest = { calendarMenuOpen = false }) {
                            for (calendar in writable) {
                                DropdownMenuItem(
                                    text = { Text(calendar.name) },
                                    onClick = {
                                        calendarMenuOpen = false
                                        onChange(draft.copy(accountId = calendar.accountId, calendarId = calendar.id))
                                    },
                                )
                            }
                        }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(tr("calendar.allDay"), modifier = Modifier.weight(1f))
                    Switch(checked = draft.allDay, onCheckedChange = { onChange(draft.withAllDay(it, offsetAt)) })
                }
                DateTimeRow(
                    label = tr("calendar.starts"),
                    day = draft.startDay(offsetAt),
                    epochSeconds = draft.start,
                    allDay = draft.allDay,
                    offsetAt = offsetAt,
                    onPickDate = { picker = PickerTarget.StartDate },
                    onPickTime = { picker = PickerTarget.StartTime },
                )
                DateTimeRow(
                    label = tr("calendar.ends"),
                    day = draft.endDay(offsetAt),
                    epochSeconds = draft.end,
                    allDay = draft.allDay,
                    offsetAt = offsetAt,
                    onPickDate = { picker = PickerTarget.EndDate },
                    onPickTime = { picker = PickerTarget.EndTime },
                )
                OutlinedTextField(
                    value = draft.location,
                    onValueChange = { onChange(draft.copy(location = it)) },
                    label = { Text(tr("calendar.location")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = draft.description,
                    onValueChange = { onChange(draft.copy(description = it)) },
                    label = { Text(tr("calendar.description")) },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (draft.base?.isRecurring == true) DetailNote(tr("mobile.calendar.occurrenceOnly"))
                if (error.isNotBlank()) {
                    Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onSave, enabled = !saving) {
                if (saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(tr("calendar.save"))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !saving) { Text(tr("calendar.cancel")) }
        },
    )

    when (val target = picker) {
        PickerTarget.StartDate, PickerTarget.EndDate -> {
            val start = target == PickerTarget.StartDate
            DayPickerDialog(
                initialDay = if (start) draft.startDay(offsetAt) else draft.endDay(offsetAt),
                onPick = { day ->
                    picker = null
                    onChange(if (start) draft.withStartDay(day, offsetAt) else draft.withEndDay(day, offsetAt))
                },
                onDismiss = { picker = null },
            )
        }

        PickerTarget.StartTime, PickerTarget.EndTime -> {
            val start = target == PickerTarget.StartTime
            val (hour, minute) = localTimeOfDay(if (start) draft.start else draft.end, offsetAt)
            ClockPickerDialog(
                title = if (start) tr("calendar.starts") else tr("calendar.ends"),
                initialHour = hour,
                initialMinute = minute,
                onPick = { h, m ->
                    picker = null
                    onChange(if (start) draft.withStartTime(h, m, offsetAt) else draft.withEndTime(h, m, offsetAt))
                },
                onDismiss = { picker = null },
            )
        }

        null -> {}
    }
}

@Composable
private fun DateTimeRow(
    label: String,
    day: Long,
    epochSeconds: Long,
    allDay: Boolean,
    offsetAt: UtcOffsetAt,
    onPickDate: () -> Unit,
    onPickTime: () -> Unit,
) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onPickDate, modifier = Modifier.weight(1f)) {
                Text(longDate(day, offsetAt), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            // An all-day event has no hour to set, so none is offered.
            if (!allDay) {
                OutlinedButton(onClick = onPickTime) { Text(formatDate(epochSeconds * 1000, DateStyle.Time)) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DayPickerDialog(
    initialDay: Long,
    onPick: (Long) -> Unit,
    onDismiss: () -> Unit,
) {
    // The picker speaks in UTC midnights, which is exactly an epoch day.
    val state = rememberDatePickerState(initialSelectedDateMillis = initialDay * SECONDS_PER_DAY * 1000)
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { onPick(it.floorDiv(SECONDS_PER_DAY * 1000)) } ?: onDismiss()
            }) { Text(tr("buttons.done")) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(tr("buttons.cancel")) } },
    ) {
        DatePicker(state = state)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ClockPickerDialog(
    title: String,
    initialHour: Int,
    initialMinute: Int,
    onPick: (Int, Int) -> Unit,
    onDismiss: () -> Unit,
) {
    val state = rememberTimePickerState(initialHour = initialHour, initialMinute = initialMinute, is24Hour = true)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { TimePicker(state = state) },
        confirmButton = { TextButton(onClick = { onPick(state.hour, state.minute) }) { Text(tr("buttons.done")) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(tr("buttons.cancel")) } },
    )
}

/** A date at local noon, safely inside the day whatever the zone does. */
private fun dayMillis(
    day: Long,
    offsetAt: UtcOffsetAt,
): Long = localEpochSeconds(day, 12, 0, offsetAt) * 1000

private fun shortDate(
    day: Long,
    offsetAt: UtcOffsetAt,
): String = formatDate(dayMillis(day, offsetAt), DateStyle.MonthDay)

private fun longDate(
    day: Long,
    offsetAt: UtcOffsetAt,
): String = formatDate(dayMillis(day, offsetAt), DateStyle.Weekday) + ", " + formatDate(dayMillis(day, offsetAt), DateStyle.MonthDayYear)

@Composable
private fun dayHeading(
    day: Long,
    today: Long,
    offsetAt: UtcOffsetAt,
): String =
    when (day) {
        today -> tr("calendar.today")
        today + 1 -> tr("calendar.tomorrow")
        else -> formatDate(dayMillis(day, offsetAt), DateStyle.Weekday) + ", " + shortDate(day, offsetAt)
    }

@Composable
private fun timeLabel(event: CalendarEvent): String =
    if (event.allDay) {
        tr("calendar.allDay")
    } else {
        formatDate(event.start * 1000, DateStyle.Time) + "–" + formatDate(event.end * 1000, DateStyle.Time)
    }

@Composable
private fun fullTimeLabel(
    event: CalendarEvent,
    offsetAt: UtcOffsetAt,
): String {
    val days = eventDays(event, offsetAt)
    return if (event.allDay) {
        // All-day days are dates, not instants: each is named from its own
        // local noon, so no zone can shift it to a neighbour.
        val first = longDate(days.first, offsetAt)
        val label = if (days.last == days.first) first else "$first – ${longDate(days.last, offsetAt)}"
        "$label · ${tr("calendar.allDay")}"
    } else if (days.last == days.first) {
        longDate(days.first, offsetAt) + ", " + formatDate(event.start * 1000, DateStyle.Time) + "–" + formatDate(event.end * 1000, DateStyle.Time)
    } else {
        formatDate(event.start * 1000, DateStyle.FullTimestamp) + " – " + formatDate(event.end * 1000, DateStyle.FullTimestamp)
    }
}

@Composable
private fun responseLabel(response: String): String? =
    when (response) {
        "accept" -> tr("calendar.accepted")
        "decline" -> tr("calendar.declined")
        "tentative" -> tr("calendar.tentative")
        "none" -> tr("calendar.noAnswer")
        else -> null
    }

private fun participantLabel(person: CalendarParticipant): String =
    when {
        person.name.isNotBlank() && person.addr.isNotBlank() -> "${person.name} <${person.addr}>"
        else -> person.name.ifBlank { person.addr }
    }

/** What a meeting service is called, as the desktop's `meetingName`. */
private fun meetingName(provider: String): String =
    when (provider) {
        "meet" -> "Google Meet"
        "zoom" -> "Zoom"
        "teams" -> "Microsoft Teams"
        "webex" -> "Webex"
        "jitsi" -> "Jitsi Meet"
        "gotomeeting" -> "GoTo Meeting"
        "whereby" -> "Whereby"
        else -> provider
    }

/** A calendar's own colour, when it has a usable "#rrggbb". */
private fun calendarColor(calendar: CalendarSummary?): Color? {
    val hex = calendar?.color?.removePrefix("#") ?: return null
    if (hex.length != 6) return null
    val rgb = hex.toLongOrNull(16) ?: return null
    return Color(0xFF000000 or rgb)
}
