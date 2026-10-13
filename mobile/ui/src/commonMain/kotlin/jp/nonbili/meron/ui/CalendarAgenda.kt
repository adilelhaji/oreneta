package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.CalendarEvent
import jp.nonbili.meron.shared.CalendarParticipant
import jp.nonbili.meron.shared.CalendarSummary

// The calendar's date arithmetic and rules, kept free of Compose and of the
// platform so they can be tested as they are. The one platform fact they need
// — how far local time is from UTC at an instant — is passed in.
//
// Times follow the core: epoch seconds, timed events read where the reader is,
// all-day events stored at midnight UTC with an exclusive end, because a date
// has no hour of its own (frontend/src/components/calendar/EventEditor.tsx).

/** Seconds local time is ahead of UTC at an instant. */
internal typealias UtcOffsetAt = (epochSeconds: Long) -> Int

internal const val SECONDS_PER_DAY = 86_400L

/** How many days the agenda shows at once. */
internal const val AGENDA_WINDOW_DAYS = 14

internal data class CivilDate(
    val year: Int,
    val month: Int,
    val day: Int,
)

/** The proleptic Gregorian date [epochDay] days after 1970-01-01. */
internal fun civilFromEpochDay(epochDay: Long): CivilDate {
    // Howard Hinnant's civil_from_days.
    val z = epochDay + 719_468
    val era = z.floorDiv(146_097L)
    val doe = z - era * 146_097
    val yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365
    val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    val mp = (5 * doy + 2) / 153
    val day = (doy - (153 * mp + 2) / 5 + 1).toInt()
    val month = (if (mp < 10) mp + 3 else mp - 9).toInt()
    val year = (yoe + era * 400 + if (month <= 2) 1 else 0).toInt()
    return CivilDate(year, month, day)
}

internal fun epochDayFromCivil(date: CivilDate): Long {
    val y = date.year.toLong() - if (date.month <= 2) 1 else 0
    val era = y.floorDiv(400L)
    val yoe = y - era * 400
    val m = date.month.toLong()
    val doy = (153 * (if (m > 2) m - 3 else m + 9) + 2) / 5 + date.day - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
}

/** The local date an instant falls on, as an epoch day. */
internal fun localEpochDay(
    epochSeconds: Long,
    offsetAt: UtcOffsetAt,
): Long = (epochSeconds + offsetAt(epochSeconds)).floorDiv(SECONDS_PER_DAY)

/** Local hour and minute of an instant. */
internal fun localTimeOfDay(
    epochSeconds: Long,
    offsetAt: UtcOffsetAt,
): Pair<Int, Int> {
    val seconds = (epochSeconds + offsetAt(epochSeconds)).mod(SECONDS_PER_DAY)
    return (seconds / 3_600).toInt() to ((seconds % 3_600) / 60).toInt()
}

/**
 * The instant a local wall-clock time names. Two passes settle the offset
 * across a daylight-saving change; a time skipped by one lands after it.
 */
internal fun localEpochSeconds(
    epochDay: Long,
    hour: Int,
    minute: Int,
    offsetAt: UtcOffsetAt,
): Long {
    val wall = epochDay * SECONDS_PER_DAY + hour * 3_600L + minute * 60L
    val guess = wall - offsetAt(wall)
    return wall - offsetAt(guess)
}

internal fun localMidnight(
    epochDay: Long,
    offsetAt: UtcOffsetAt,
): Long = localEpochSeconds(epochDay, 0, 0, offsetAt)

/** [days] local days from [startDay]: what one agenda page asks the core for. */
internal data class AgendaWindow(
    val startDay: Long,
    val days: Int = AGENDA_WINDOW_DAYS,
) {
    val endDayExclusive: Long get() = startDay + days

    /** The half-open window [from, to) in epoch seconds, as `calendar.events` takes it. */
    fun bounds(offsetAt: UtcOffsetAt): Pair<Long, Long> = localMidnight(startDay, offsetAt) to localMidnight(endDayExclusive, offsetAt)

    fun next(): AgendaWindow = copy(startDay = startDay + days)

    fun previous(): AgendaWindow = copy(startDay = startDay - days)
}

/**
 * The agenda window that holds now. With a first day of the week (ISO, 1 =
 * Monday … 7 = Sunday) it opens on the start of this week, so its pages are
 * whole weeks as on the desktop; without one it opens on today.
 */
internal fun agendaWindowFrom(
    nowSeconds: Long,
    offsetAt: UtcOffsetAt,
    days: Int = AGENDA_WINDOW_DAYS,
    firstDayOfWeek: Int? = null,
): AgendaWindow {
    val today = localEpochDay(nowSeconds, offsetAt)
    val back = if (firstDayOfWeek == null) 0 else (isoWeekday(today) - firstDayOfWeek).mod(7)
    return AgendaWindow(today - back, days)
}

/** ISO weekday of an epoch day, 1 = Monday … 7 = Sunday. 1970-01-01 was a Thursday. */
internal fun isoWeekday(epochDay: Long): Int = (epochDay + 3).mod(7L).toInt() + 1

/**
 * Core `settings` row holding the week's first day, written by the desktop's
 * Calendar → General (ADR-0051). Shared with the desktop, not namespaced under
 * `mobile.`, like [APP_SIGNATURE_SETTING_KEY].
 */
internal const val CALENDAR_WEEK_START_SETTING_KEY = "calendar_week_start"

/**
 * The first day an explicit choice names, as an ISO weekday. The desktop's
 * "locale" default (and anything unknown) is null: the agenda then keeps
 * opening on today, since common code has no regional week data.
 */
internal fun calendarWeekStartFromSetting(value: Any?): Int? =
    when (value) {
        "monday" -> 1
        "saturday" -> 6
        "sunday" -> 7
        else -> null
    }

/**
 * The days an event covers, first and last inclusive: its dates for an
 * all-day event, the local days it touches for a timed one. An event ending
 * exactly at midnight does not spill into the next day.
 */
internal fun eventDays(
    event: CalendarEvent,
    offsetAt: UtcOffsetAt,
): LongRange {
    val lastInstant = maxOf(event.start, event.end - 1)
    return if (event.allDay) {
        val first = event.start.floorDiv(SECONDS_PER_DAY)
        first..maxOf(first, lastInstant.floorDiv(SECONDS_PER_DAY))
    } else {
        val first = localEpochDay(event.start, offsetAt)
        first..maxOf(first, localEpochDay(lastInstant, offsetAt))
    }
}

internal data class AgendaDay(
    val epochDay: Long,
    val events: List<CalendarEvent>,
)

/**
 * The window's events by day, each listed on every day it covers, days in
 * order and only those with something on them. Within a day all-day events
 * come first, then by start. Events on hidden calendars are left out.
 */
internal fun groupAgenda(
    events: List<CalendarEvent>,
    window: AgendaWindow,
    offsetAt: UtcOffsetAt,
    calendars: List<CalendarSummary> = emptyList(),
): List<AgendaDay> {
    val hidden = calendars.filterNot { it.enabled }.map { it.accountId to it.id }.toSet()
    val byDay = mutableMapOf<Long, MutableList<CalendarEvent>>()
    for (event in events) {
        if ((event.accountId to event.calendarId) in hidden) continue
        val days = eventDays(event, offsetAt)
        val first = maxOf(days.first, window.startDay)
        val last = minOf(days.last, window.endDayExclusive - 1)
        for (day in first..last) byDay.getOrPut(day) { mutableListOf() } += event
    }
    return byDay.entries.sortedBy { it.key }.map { (day, dayEvents) ->
        AgendaDay(
            day,
            dayEvents.sortedWith(compareBy<CalendarEvent>({ !it.allDay }, { it.start }, { it.subject.lowercase() })),
        )
    }
}

/**
 * The calendars a new event can be saved to: shown, and neither read-only
 * nor a subscription — the desktop's `writableCalendars`.
 */
internal fun writableCalendars(calendars: List<CalendarSummary>): List<CalendarSummary> = calendars.filter { it.enabled && !it.readOnly && it.kind != "subscribed" }

internal fun calendarOf(
    event: CalendarEvent,
    calendars: List<CalendarSummary>,
): CalendarSummary? = calendars.find { it.accountId == event.accountId && it.id == event.calendarId }

/**
 * Whether an event's attendees are in the window answer already. Exchange's
 * window query never carries them, so an account calendar's are known only
 * once `calendar.eventDetails` has answered.
 */
internal fun attendeesComeWithWindow(calendar: CalendarSummary?): Boolean = calendar?.kind in setOf("local", "caldav", "subscribed")

/** Why an event cannot be changed from mobile, if it cannot. */
internal enum class EventEditBlock {
    None,

    /** A read-only calendar or a subscription: it belongs to someone else. */
    ReadOnly,

    /**
     * Other people are on it, or it is someone else's meeting. Mobile does not
     * send invitations or cancellations, so a change here would leave them
     * with a copy that no longer matches; it is left to the desktop.
     */
    Guests,

    /** Who is on it is not known yet (details still loading, or unreachable). */
    GuestsUnknown,
}

internal fun mobileEditBlock(
    event: CalendarEvent,
    calendar: CalendarSummary?,
    attendeesKnown: Boolean,
    attendees: List<CalendarParticipant>,
    ownAddresses: Set<String>,
): EventEditBlock {
    if (calendar == null || calendar.readOnly || calendar.kind == "subscribed") return EventEditBlock.ReadOnly
    val own = ownAddresses.map { it.trim().lowercase() }.toSet()

    fun isSomeoneElse(addr: String): Boolean = addr.isNotBlank() && addr.trim().lowercase() !in own
    if (event.organizer?.addr?.let(::isSomeoneElse) == true) return EventEditBlock.Guests
    if (!attendeesKnown) return EventEditBlock.GuestsUnknown
    if ((attendees + event.attendees).any { isSomeoneElse(it.addr) }) return EventEditBlock.Guests
    return EventEditBlock.None
}

/** What the editor holds. A new event has no [base]; the core assigns its id. */
internal data class EventDraft(
    val base: CalendarEvent?,
    val accountId: String,
    val calendarId: String,
    val subject: String = "",
    val location: String = "",
    val description: String = "",
    val allDay: Boolean = false,
    val start: Long,
    val end: Long,
) {
    val isNew: Boolean get() = base == null

    /** The event to send: what was read, with what the editor changes laid over it. */
    fun toEvent(): CalendarEvent {
        val read = base ?: CalendarEvent(id = "", calendarId = calendarId, start = start, end = end, accountId = accountId)
        return read.copy(
            calendarId = calendarId,
            subject = subject,
            // Left alone when there was none and none was typed.
            location = if (base != null && base.location == null && location.isEmpty()) null else location,
            description = description,
            allDay = allDay,
            start = start,
            end = end,
            accountId = accountId,
        )
    }

    /** The catalog key of what is wrong with it, or null when it can be saved. */
    fun problemKey(): String? = if (end < start || (allDay && end <= start)) "calendar.endsBeforeStart" else null

    /**
     * Switches between a timed and an all-day event the way the desktop does:
     * all day covers the start's date, at midnight UTC; back to timed lands on
     * that date at nine, for an hour.
     */
    fun withAllDay(
        value: Boolean,
        offsetAt: UtcOffsetAt,
    ): EventDraft {
        if (value == allDay) return this
        return if (value) {
            val first = localEpochDay(start, offsetAt) * SECONDS_PER_DAY
            copy(allDay = true, start = first, end = first + SECONDS_PER_DAY)
        } else {
            val begins = localEpochSeconds(start.floorDiv(SECONDS_PER_DAY), 9, 0, offsetAt)
            copy(allDay = false, start = begins, end = begins + 3_600)
        }
    }

    /** The start's date, as an epoch day. */
    fun startDay(offsetAt: UtcOffsetAt): Long = if (allDay) start.floorDiv(SECONDS_PER_DAY) else localEpochDay(start, offsetAt)

    /** The last date it covers (inclusive for all-day, whose stored end is exclusive). */
    fun endDay(offsetAt: UtcOffsetAt): Long = if (allDay) maxOf(start, end - 1).floorDiv(SECONDS_PER_DAY) else localEpochDay(end, offsetAt)

    /** Moves the start to another date, keeping its time and the event's length. */
    fun withStartDay(
        day: Long,
        offsetAt: UtcOffsetAt,
    ): EventDraft {
        val length = end - start
        val begins =
            if (allDay) {
                day * SECONDS_PER_DAY
            } else {
                val (hour, minute) = localTimeOfDay(start, offsetAt)
                localEpochSeconds(day, hour, minute, offsetAt)
            }
        return copy(start = begins, end = begins + length)
    }

    /** Moves the start to another time of its day, keeping the length. */
    fun withStartTime(
        hour: Int,
        minute: Int,
        offsetAt: UtcOffsetAt,
    ): EventDraft {
        val length = end - start
        val begins = localEpochSeconds(localEpochDay(start, offsetAt), hour, minute, offsetAt)
        return copy(start = begins, end = begins + length)
    }

    fun withEndDay(
        day: Long,
        offsetAt: UtcOffsetAt,
    ): EventDraft =
        if (allDay) {
            copy(end = (day + 1) * SECONDS_PER_DAY)
        } else {
            val (hour, minute) = localTimeOfDay(end, offsetAt)
            copy(end = localEpochSeconds(day, hour, minute, offsetAt))
        }

    fun withEndTime(
        hour: Int,
        minute: Int,
        offsetAt: UtcOffsetAt,
    ): EventDraft = copy(end = localEpochSeconds(localEpochDay(end, offsetAt), hour, minute, offsetAt))
}

/**
 * A new event on the default writable calendar (or the first), at the next
 * round hour for an hour, as the desktop opens one. Null when no calendar
 * can take it: inventing one would only fail at save time.
 */
internal fun newEventDraft(
    calendars: List<CalendarSummary>,
    nowSeconds: Long,
): EventDraft? {
    val writable = writableCalendars(calendars)
    val target = writable.find { it.isDefault } ?: writable.firstOrNull() ?: return null
    val start = (nowSeconds + 3_599).floorDiv(3_600L) * 3_600
    return EventDraft(base = null, accountId = target.accountId, calendarId = target.id, start = start, end = start + 3_600)
}

/**
 * An editor on an existing occurrence. Notes come from `calendar.eventDetails`
 * when the window carried none (Exchange never does), so what is saved is what
 * the reader was shown.
 */
internal fun editDraftOf(
    event: CalendarEvent,
    detailsDescription: String? = null,
): EventDraft =
    EventDraft(
        base = event,
        accountId = event.accountId,
        calendarId = event.calendarId,
        subject = event.subject,
        location = event.location.orEmpty(),
        description = event.description.ifBlank { detailsDescription.orEmpty() },
        allDay = event.allDay,
        start = event.start,
        end = event.end,
    )
