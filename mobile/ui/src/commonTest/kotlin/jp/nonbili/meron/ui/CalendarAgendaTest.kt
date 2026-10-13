package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.CalendarCreateParams
import jp.nonbili.meron.shared.CalendarDeleteParams
import jp.nonbili.meron.shared.CalendarEvent
import jp.nonbili.meron.shared.CalendarEventsParams
import jp.nonbili.meron.shared.CalendarParticipant
import jp.nonbili.meron.shared.CalendarSummary
import jp.nonbili.meron.shared.CalendarUpdateParams
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CalendarAgendaTest {
    private val utc: UtcOffsetAt = { 0 }

    // Madrid in 2026: UTC+1, and UTC+2 from 2026-03-29 01:00 UTC to
    // 2026-10-25 01:00 UTC.
    private val madrid: UtcOffsetAt = { at -> if (at in 1_774_746_000L until 1_792_890_000L) 7_200 else 3_600 }

    // 2026-10-12 is epoch day 20_738.
    private val oct12 = epochDayFromCivil(CivilDate(2026, 10, 12))

    private fun event(
        id: String,
        start: Long,
        end: Long,
        allDay: Boolean = false,
        calendarId: String = "work",
        accountId: String = "acc",
        subject: String = id,
    ) = CalendarEvent(id = id, calendarId = calendarId, subject = subject, start = start, end = end, allDay = allDay, accountId = accountId)

    private fun calendar(
        id: String,
        kind: String = "account",
        readOnly: Boolean = false,
        enabled: Boolean = true,
        isDefault: Boolean = false,
    ) = CalendarSummary(id = id, name = id, kind = kind, readOnly = readOnly, enabled = enabled, isDefault = isDefault, accountId = "acc")

    @Test
    fun civilDatesRoundTrip() {
        assertEquals(0, epochDayFromCivil(CivilDate(1970, 1, 1)))
        assertEquals(20_738, oct12)
        assertEquals(CivilDate(2026, 10, 12), civilFromEpochDay(oct12))
        assertEquals(CivilDate(2024, 2, 29), civilFromEpochDay(epochDayFromCivil(CivilDate(2024, 2, 29))))
        assertEquals(CivilDate(1969, 12, 31), civilFromEpochDay(-1))
    }

    @Test
    fun theWindowStartsAtLocalMidnightAndAsksTheCoreForWholeDays() {
        // 2026-10-12 00:30 in Madrid is still 2026-10-11 in UTC.
        val now = oct12 * SECONDS_PER_DAY - 7_200 + 1_800
        val window = agendaWindowFrom(now, madrid)
        assertEquals(oct12, window.startDay)
        val (from, to) = window.bounds(madrid)
        assertEquals(oct12 * SECONDS_PER_DAY - 7_200, from)
        // Fourteen days on, past the switch back to winter time on the 25th.
        assertEquals((oct12 + 14) * SECONDS_PER_DAY - 3_600, to)
        assertEquals(
            CalendarEventsParams("acc", from, to).toJson(),
            """{"account":"acc","from":$from,"to":$to,"refresh":true}""",
        )
        assertEquals(oct12 + 14, window.next().startDay)
        assertEquals(oct12 - 14, window.previous().startDay)
    }

    @Test
    fun theWindowOpensOnTheDesktopsFirstDayOfTheWeek() {
        // 2026-10-12 is a Monday; 2026-10-14 10:00 Madrid is a Wednesday.
        assertEquals(1, isoWeekday(oct12))
        assertEquals(4, isoWeekday(0))
        assertEquals(7, isoWeekday(oct12 - 1))
        val wednesday = (oct12 + 2) * SECONDS_PER_DAY - 7_200 + 10 * 3_600
        assertEquals(oct12 + 2, agendaWindowFrom(wednesday, madrid).startDay)
        assertEquals(oct12, agendaWindowFrom(wednesday, madrid, firstDayOfWeek = 1).startDay)
        assertEquals(oct12 - 1, agendaWindowFrom(wednesday, madrid, firstDayOfWeek = 7).startDay)
        assertEquals(oct12 - 2, agendaWindowFrom(wednesday, madrid, firstDayOfWeek = 6).startDay)
        // On the first day itself the window opens on today; pages stay whole weeks.
        val sunday = (oct12 - 1) * SECONDS_PER_DAY + 12 * 3_600
        assertEquals(oct12 - 1, agendaWindowFrom(sunday, madrid, firstDayOfWeek = 7).startDay)
        assertEquals(oct12 + 13, agendaWindowFrom(sunday, madrid, firstDayOfWeek = 7).next().startDay)
    }

    @Test
    fun theWeekStartSettingIsReadAsTheDesktopWritesIt() {
        assertEquals("calendar_week_start", CALENDAR_WEEK_START_SETTING_KEY)
        assertEquals(1, calendarWeekStartFromSetting("monday"))
        assertEquals(7, calendarWeekStartFromSetting("sunday"))
        assertEquals(6, calendarWeekStartFromSetting("saturday"))
        // The regional default needs week data common code does not have.
        assertNull(calendarWeekStartFromSetting("locale"))
        assertNull(calendarWeekStartFromSetting(null))
        assertNull(calendarWeekStartFromSetting(1L))
    }

    @Test
    fun agendaGroupsByLocalDaySpanningDaysAndPuttingAllDayFirst() {
        val day = oct12 * SECONDS_PER_DAY
        val events =
            listOf(
                // 23:30–00:30 Madrid: touches the 12th and the 13th.
                event("late", day - 7_200 + 23 * 3_600 + 1_800, day - 7_200 + 24 * 3_600 + 1_800),
                event("morning", day - 7_200 + 9 * 3_600, day - 7_200 + 10 * 3_600),
                // All day on the 12th, stored at midnight UTC with an exclusive end.
                event("holiday", day, day + SECONDS_PER_DAY, allDay = true),
                // Ends exactly at midnight: the 12th only.
                event("evening", day - 7_200 + 22 * 3_600, day - 7_200 + 24 * 3_600),
                // Outside the window.
                event("next-month", day + 40 * SECONDS_PER_DAY, day + 40 * SECONDS_PER_DAY + 3_600),
            )
        val agenda = groupAgenda(events, AgendaWindow(oct12), madrid)
        assertEquals(listOf(oct12, oct12 + 1), agenda.map { it.epochDay })
        assertEquals(listOf("holiday", "morning", "evening", "late"), agenda[0].events.map { it.id })
        assertEquals(listOf("late"), agenda[1].events.map { it.id })
    }

    @Test
    fun allDayEventsKeepTheirDateWestOfGreenwich() {
        val newYork: UtcOffsetAt = { -4 * 3_600 }
        val holiday = event("h", oct12 * SECONDS_PER_DAY, (oct12 + 2) * SECONDS_PER_DAY, allDay = true)
        assertEquals(oct12..(oct12 + 1), eventDays(holiday, newYork))
    }

    @Test
    fun hiddenCalendarsLeaveTheAgenda() {
        val day = oct12 * SECONDS_PER_DAY
        val agenda =
            groupAgenda(
                listOf(event("a", day + 3_600, day + 7_200), event("b", day + 3_600, day + 7_200, calendarId = "hidden")),
                AgendaWindow(oct12),
                utc,
                calendars = listOf(calendar("work"), calendar("hidden", enabled = false)),
            )
        assertEquals(listOf("a"), agenda.single().events.map { it.id })
    }

    @Test
    fun newEventsGoOnlyToCalendarsThatTakeThem() {
        val calendars =
            listOf(
                calendar("holidays", kind = "subscribed", readOnly = true, isDefault = true),
                calendar("shared", readOnly = true),
                calendar("hidden", enabled = false),
                calendar("home", kind = "local"),
                calendar("work", isDefault = true),
            )
        assertEquals(listOf("home", "work"), writableCalendars(calendars).map { it.id })
        val now = oct12 * SECONDS_PER_DAY + 10 * 3_600 + 5 * 60
        val draft = assertNotNull(newEventDraft(calendars, now))
        assertEquals("work", draft.calendarId, "the default writable calendar, not the default subscription")
        assertEquals(oct12 * SECONDS_PER_DAY + 11 * 3_600, draft.start)
        assertEquals(draft.start + 3_600, draft.end)
        assertNull(newEventDraft(listOf(calendar("holidays", kind = "subscribed")), now))
    }

    @Test
    fun mobileNeverChangesEventsOthersAreOn() {
        val work = calendar("work")
        val mine = setOf("me@example.com")
        val plain = event("e", 0, 3_600)
        assertEquals(EventEditBlock.None, mobileEditBlock(plain, work, attendeesKnown = true, attendees = emptyList(), ownAddresses = mine))
        assertEquals(EventEditBlock.GuestsUnknown, mobileEditBlock(plain, work, attendeesKnown = false, attendees = emptyList(), ownAddresses = mine))
        assertEquals(
            EventEditBlock.Guests,
            mobileEditBlock(plain, work, true, listOf(CalendarParticipant("Bo", "bo@example.com")), mine),
        )
        // Being on the list yourself is not a guest to tell.
        assertEquals(EventEditBlock.None, mobileEditBlock(plain, work, true, listOf(CalendarParticipant("Me", "ME@example.com")), mine))
        val theirs = plain.copy(organizer = CalendarParticipant("Ana", "ana@example.com"))
        assertEquals(EventEditBlock.Guests, mobileEditBlock(theirs, work, true, emptyList(), mine))
        assertEquals(EventEditBlock.ReadOnly, mobileEditBlock(plain, calendar("shared", readOnly = true), true, emptyList(), mine))
        assertEquals(EventEditBlock.ReadOnly, mobileEditBlock(plain, calendar("h", kind = "subscribed"), true, emptyList(), mine))
        assertEquals(EventEditBlock.ReadOnly, mobileEditBlock(plain, null, true, emptyList(), mine))
        assertTrue(attendeesComeWithWindow(calendar("home", kind = "local")))
        assertFalse(attendeesComeWithWindow(work))
    }

    @Test
    fun allDayTogglesLikeTheDesktop() {
        val start = oct12 * SECONDS_PER_DAY - 7_200 + 15 * 3_600 + 32 * 60
        val draft = EventDraft(base = null, accountId = "acc", calendarId = "work", start = start, end = start + 1_800)
        val allDay = draft.withAllDay(true, madrid)
        assertEquals(oct12 * SECONDS_PER_DAY, allDay.start)
        assertEquals((oct12 + 1) * SECONDS_PER_DAY, allDay.end)
        assertEquals(oct12, allDay.endDay(madrid), "the stored end is exclusive; the editor shows the last day")
        val timed = allDay.withAllDay(false, madrid)
        assertEquals(oct12 * SECONDS_PER_DAY - 7_200 + 9 * 3_600, timed.start)
        assertEquals(timed.start + 3_600, timed.end)
    }

    @Test
    fun movingTheStartKeepsTheLengthAndTheEndCanBeSetApart() {
        val start = oct12 * SECONDS_PER_DAY + 9 * 3_600
        val draft = EventDraft(base = null, accountId = "acc", calendarId = "work", start = start, end = start + 5_400)
        val later = draft.withStartTime(14, 15, utc)
        assertEquals(oct12 * SECONDS_PER_DAY + 14 * 3_600 + 15 * 60, later.start)
        assertEquals(later.start + 5_400, later.end)
        val nextDay = later.withStartDay(oct12 + 1, utc)
        assertEquals(later.start + SECONDS_PER_DAY, nextDay.start)
        val shorter = nextDay.withEndTime(15, 0, utc)
        assertEquals(nextDay.start + 45 * 60, shorter.end)
        assertNull(shorter.problemKey())
        assertEquals("calendar.endsBeforeStart", shorter.withEndDay(oct12, utc).problemKey())
        val allDay = draft.withAllDay(true, utc).withEndDay(oct12 + 2, utc)
        assertEquals((oct12 + 3) * SECONDS_PER_DAY, allDay.end)
    }

    @Test
    fun savesSendTheEventAsReadWithTheEditsLaidOver() {
        val read =
            CalendarEvent(
                id = "ev-1",
                calendarId = "work",
                changeKey = "ck-1",
                subject = "Planning",
                location = null,
                start = 1_000,
                end = 4_600,
                reminderMinutes = 15,
                seriesId = "series-1",
                isRecurring = true,
                accountId = "acc",
            )
        val edited = editDraftOf(read, detailsDescription = "From the server").copy(subject = "Planning (moved)")
        assertEquals("From the server", edited.description, "notes the window lacked come from the details")
        val event = edited.toEvent()
        assertEquals("ck-1", event.changeKey, "the change key it was read with travels back")
        assertEquals(15, event.reminderMinutes, "a reminder the editor does not show is kept")
        assertNull(event.location, "no location typed onto one that had none")
        assertEquals(
            """{"account":"acc","event":{"id":"ev-1","calendar_id":"work","change_key":"ck-1","subject":"Planning (moved)","start":1000,"end":4600,""" +
                """"all_day":false,"is_recurring":true,"reminder_minutes":15,"description":"From the server","series_id":"series-1","is_cancelled":false,""" +
                """"free_busy":"","my_response":"","attendees":[]},"scope":"occurrence","notify":false}""",
            CalendarUpdateParams(event).toJson(),
        )
        assertEquals(
            """{"account":"acc","event":"ev-1","calendar":"work","change_key":"ck-1","series":"series-1","scope":"occurrence","notify":false}""",
            CalendarDeleteParams(read).toJson(),
        )

        val created = EventDraft(base = null, accountId = "acc", calendarId = "home", subject = "Dentist", start = 7_200, end = 10_800).toEvent()
        assertEquals(
            """{"account":"acc","event":{"id":"","calendar_id":"home","subject":"Dentist","location":"","start":7200,"end":10800,"all_day":false,""" +
                """"is_recurring":false,"description":"","is_cancelled":false,"free_busy":"","my_response":"","attendees":[]},"notify":false}""",
            CalendarCreateParams(created).toJson(),
        )
    }
}
