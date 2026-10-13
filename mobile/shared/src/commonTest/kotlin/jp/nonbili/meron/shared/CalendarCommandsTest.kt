package jp.nonbili.meron.shared

import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CalendarCommandsTest {
    // What the core's serde writes for `calendar.list`, inside the envelope the
    // platform cores hand back.
    private val calendarsJson =
        """{"id":1,"result":{"calendars":[""" +
            """{"id":"cal-work","name":"Work","is_default":true,"enabled":true,"color":"#3366ff","kind":"account","url":null,"read_only":false,"synced_at":0},""" +
            """{"id":"https://example.com/h.ics","name":"Holidays","is_default":false,"enabled":false,"color":null,"kind":"subscribed","url":"https://example.com/h.ics","read_only":true,"synced_at":1760000000},""" +
            """{"id":"","name":"nameless"}""" +
            """]}}"""

    private val eventsJson =
        """{"id":1,"result":{"events":[""" +
            """{"id":"ev-1","calendar_id":"cal-work","change_key":"ck-1","subject":"Planning","location":"Room \"A\"","start":1760090400,"end":1760094000,""" +
            """"all_day":false,"is_recurring":true,"recurrence":null,"reminder_minutes":15,"description":"Bring notes","series_id":"series-1","is_cancelled":false,""" +
            """"free_busy":"busy","my_response":"accept","organizer":{"name":"Ana","addr":"ana@example.com","response":""},""" +
            """"attendees":[{"name":"Bo","addr":"bo@example.com","response":"tentative"}],"meeting":{"provider":"meet","url":"https://meet.google.com/abc-defg-hij"}},""" +
            """{"id":"local:1","calendar_id":"home","change_key":"0","subject":"Holiday","location":null,"start":1760054400,"end":1760140800,"all_day":true,""" +
            """"is_recurring":false,"recurrence":null,"reminder_minutes":null,"description":"","series_id":null,"is_cancelled":false,"free_busy":"","my_response":"","organizer":null,"attendees":[],"meeting":null}""" +
            """]}}"""

    @Test
    fun calendarListReadsEveryFieldAndStampsTheAccount() {
        val calendars = parseCalendarListResponse(calendarsJson, "acc-1")
        assertEquals(2, calendars.size, "a calendar without an id is dropped")
        val work = calendars[0]
        assertEquals("cal-work", work.id)
        assertEquals("Work", work.name)
        assertTrue(work.isDefault)
        assertTrue(work.enabled)
        assertEquals("#3366ff", work.color)
        assertEquals("account", work.kind)
        assertNull(work.url)
        assertFalse(work.readOnly)
        assertEquals("acc-1", work.accountId)
        val holidays = calendars[1]
        assertEquals("subscribed", holidays.kind)
        assertTrue(holidays.readOnly)
        assertFalse(holidays.enabled)
        assertEquals("https://example.com/h.ics", holidays.url)
        assertEquals(1760000000, holidays.syncedAt)
    }

    @Test
    fun eventsReadNestedOrganizerAttendeesAndMeetingWithoutConfusingTheirKeys() {
        val events = parseCalendarEventsResponse(eventsJson, "acc-1")
        assertEquals(2, events.size)
        val planning = events[0]
        assertEquals("ev-1", planning.id)
        assertEquals("cal-work", planning.calendarId)
        assertEquals("ck-1", planning.changeKey)
        assertEquals("Planning", planning.subject)
        assertEquals("Room \"A\"", planning.location)
        assertEquals(1760090400, planning.start)
        assertEquals(1760094000, planning.end)
        assertFalse(planning.allDay)
        assertTrue(planning.isRecurring)
        assertEquals(15, planning.reminderMinutes)
        assertEquals("Bring notes", planning.description)
        assertEquals("series-1", planning.seriesId)
        assertEquals("busy", planning.freeBusy)
        assertEquals("accept", planning.myResponse)
        assertEquals(CalendarParticipant("Ana", "ana@example.com", ""), planning.organizer)
        assertEquals(listOf(CalendarParticipant("Bo", "bo@example.com", "tentative")), planning.attendees)
        assertEquals(OnlineMeeting("meet", "https://meet.google.com/abc-defg-hij"), planning.meeting)
        assertEquals("acc-1", planning.accountId)

        val holiday = events[1]
        assertTrue(holiday.allDay)
        assertNull(holiday.location)
        assertNull(holiday.reminderMinutes)
        assertNull(holiday.organizer)
        assertNull(holiday.meeting)
        assertTrue(holiday.attendees.isEmpty())
    }

    @Test
    fun parsersAcceptABareResultAndAnEmptyAnswer() {
        assertEquals(1, parseCalendarEventsResponse("""{"events":[{"id":"x","calendar_id":"c","subject":"s","start":1,"end":2}]}""", "a").size)
        assertTrue(parseCalendarEventsResponse("""{"id":1,"result":{"events":[]}}""", "a").isEmpty())
        assertTrue(parseCalendarListResponse("{}", "a").isEmpty())
    }

    @Test
    fun eventDetailsCarryAttendeesAndNotes() {
        val details =
            parseCalendarEventDetailsResponse(
                """{"id":1,"result":{"attendees":[{"name":"","addr":"cy@example.com","response":"none"}],"description":"Line one\nLine two"}}""",
            )
        assertEquals(listOf(CalendarParticipant("", "cy@example.com", "none")), details.attendees)
        assertEquals("Line one\nLine two", details.description)
    }

    // The desktop bridge (calendar.go) forwards these to the core under these
    // names; mobile talks to the core directly, so it must send the same.
    @Test
    fun readRequestsUseTheDesktopCoreParamNames() {
        assertEquals("calendar.list", MobileCommand.CalendarList)
        assertEquals("calendar.setEnabled", MobileCommand.CalendarSetEnabled)
        assertEquals("calendar.events", MobileCommand.CalendarEvents)
        assertEquals("calendar.eventDetails", MobileCommand.CalendarEventDetails)
        assertEquals("""{"account":"acc-1"}""", CalendarListParams("acc-1").toJson())
        assertEquals(
            """{"account":"acc-1","calendar":"cal-work","enabled":false}""",
            CalendarSetEnabledParams("acc-1", "cal-work", false).toJson(),
        )
        assertEquals(
            """{"account":"acc-1","name":"Home \"main\""}""",
            CalendarCreateLocalParams("acc-1", "Home \"main\"").toJson(),
        )
        assertEquals(MobileCommand.CalendarCreateLocal, "calendar.createLocal")
        assertEquals(
            """{"account":"acc-1","from":100,"to":200,"refresh":true}""",
            CalendarEventsParams("acc-1", 100, 200).toJson(),
        )
        assertEquals(
            """{"account":"acc-1","calendar":"cal-work","event":"ev-1","change_key":"ck-1"}""",
            CalendarEventDetailsParams("acc-1", "cal-work", "ev-1", "ck-1").toJson(),
        )
    }

    @Test
    fun writesNeverNotifyAndOnlyEverReachOneOccurrence() {
        val event = parseCalendarEventsResponse(eventsJson, "acc-1").first()
        assertEquals("calendar.create", MobileCommand.CalendarCreate)
        assertEquals("calendar.update", MobileCommand.CalendarUpdate)
        assertEquals("calendar.delete", MobileCommand.CalendarDelete)

        val create = CalendarCreateParams(event.copy(id = "")).toJson()
        assertTrue(create.startsWith("""{"account":"acc-1","event":{"id":"","calendar_id":"cal-work","""), create)
        assertTrue(create.endsWith(""","notify":false}"""), create)

        val update = CalendarUpdateParams(event).toJson()
        assertTrue(update.endsWith(""","scope":"occurrence","notify":false}"""), update)

        assertEquals(
            """{"account":"acc-1","event":"ev-1","calendar":"cal-work","change_key":"ck-1","series":"series-1","scope":"occurrence","notify":false}""",
            CalendarDeleteParams(event).toJson(),
        )
        val local = parseCalendarEventsResponse(eventsJson, "acc-1")[1]
        assertEquals(
            """{"account":"acc-1","event":"local:1","calendar":"home","change_key":"0","series":"","scope":"occurrence","notify":false}""",
            CalendarDeleteParams(local).toJson(),
        )
    }

    @Test
    fun anEventRoundTripsThroughTheCoreShape() {
        val event = parseCalendarEventsResponse(eventsJson, "acc-1").first()
        val json = event.toCoreJson()
        assertEquals(
            """{"id":"ev-1","calendar_id":"cal-work","change_key":"ck-1","subject":"Planning","location":"Room \"A\"","start":1760090400,"end":1760094000,""" +
                """"all_day":false,"is_recurring":true,"reminder_minutes":15,"description":"Bring notes","series_id":"series-1","is_cancelled":false,""" +
                """"free_busy":"busy","my_response":"accept","organizer":{"name":"Ana","addr":"ana@example.com","response":""},""" +
                """"attendees":[{"name":"Bo","addr":"bo@example.com","response":"tentative"}],"meeting":{"provider":"meet","url":"https://meet.google.com/abc-defg-hij"}}""",
            json,
        )
        // The account is stamped on when read and never sent inside the event.
        assertFalse("accountId" in json || "acc-1" in json)
        assertEquals(event, parseCalendarEvent(json, "acc-1"))
    }

    @Test
    fun clientSendsCommandsAndSurfacesCoreErrors() {
        val core = RecordingCore("""{"id":1,"result":{"ok":true}}""")
        val client = MobileCalendarCommandClient(core)
        val event = parseCalendarEventsResponse(eventsJson, "acc-1").first()
        runBlockingTest { client.delete(CalendarDeleteParams(event)) }
        assertEquals("calendar.delete", core.lastCommand)
        assertEquals(CalendarDeleteParams(event).toJson(), core.lastPayloadJson)

        val failing = MobileCalendarCommandClient(RecordingCore("""{"id":1,"error":{"message":"unknown method: calendar.list"}}"""))
        val error = assertFailsWith<RuntimeException> { runBlockingTest { failing.listCalendars(CalendarListParams("acc-1")) } }
        assertTrue(isUnknownCoreMethod(error.message))
        assertFalse(isUnknownCoreMethod("an event cannot end before it starts"))
        assertFalse(isUnknownCoreMethod(null))
    }
}

internal class RecordingCore(
    private val response: String,
) : MeronCore {
    var lastCommand = ""
    var lastPayloadJson = ""

    override suspend fun invoke(
        command: String,
        payloadJson: String,
    ): String {
        lastCommand = command
        lastPayloadJson = payloadJson
        return response
    }

    override fun events(): CoreEventStream =
        object : CoreEventStream {
            override fun subscribe(listener: (CoreEvent) -> Unit): CloseableHandle = CloseableHandle {}
        }

    override suspend fun protocolVersion(): Int = EXPECTED_PROTOCOL_VERSION
}

internal fun <T> runBlockingTest(block: suspend () -> T): T {
    var value: Result<T>? = null
    block.startCoroutine(Continuation(EmptyCoroutineContext) { value = it })
    @Suppress("UNCHECKED_CAST")
    return (value ?: error("suspended")).getOrThrow()
}
