package jp.nonbili.meron.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PimRefreshTest {
    // What meron-core's `pim.refresh` answers, inside the platform envelope.
    private val refreshJson =
        """{"id":1,"result":{"reminders":[""" +
            """{"account":"me@example.com","event":"local:1","subject":"Dentist","location":"Clinic","start":1800000600,"all_day":false,"minutes":15},""" +
            """{"account":"me@example.com","event":"local:2","subject":"","location":null,"start":1800003600,"all_day":true,"minutes":null},""" +
            """{"account":"","event":"broken","start":1}""" +
            """],"calendars":[{"account":"ews@example.com","ok":true},""" +
            """{"account":"g@gmail.com","ok":false,"error":"calendar sync: this account has not granted calendar access yet — reconnect it"}],""" +
            """"books":[{"id":"google-g@gmail.com","account":"g@gmail.com","kind":"google","ok":false,"error":"this account has not granted access to its contacts yet"},""" +
            """{"id":"carddav-1","account":"","kind":"carddav","ok":true,"error":null}]}}"""

    @Test
    fun theRefreshAnswerIsReadIntoRemindersAndFailures() {
        val report = parsePimRefreshResponse(refreshJson)
        assertEquals(
            listOf(
                CalendarReminder("me@example.com", "local:1", "Dentist", "Clinic", 1_800_000_600, false, 15),
                CalendarReminder("me@example.com", "local:2", "", null, 1_800_003_600, true, null),
            ),
            report.reminders,
            "an entry without an account is dropped",
        )
        assertEquals(listOf("ews@example.com"), report.calendarsRefreshed)
        assertEquals(listOf("carddav-1"), report.booksRefreshed)
        assertEquals(2, report.failures.size)
        assertEquals(PimSyncKind.Calendar, report.failures[0].kind)
        assertEquals("g@gmail.com", report.failures[0].key)
        assertEquals(PimSyncKind.AddressBook, report.failures[1].kind)
        assertEquals("google-g@gmail.com", report.failures[1].key)
        assertEquals("g@gmail.com", report.failures[1].accountId)
        assertTrue(report.failures.all { pimSyncNeedsGoogleScope(it.message) })
    }

    @Test
    fun anEmptyOrForeignAnswerIsAnEmptyReport() {
        assertEquals(PimRefreshReport(), parsePimRefreshResponse("""{"id":1,"result":{}}"""))
        assertEquals(PimRefreshReport(), parsePimRefreshResponse("not json"))
    }

    @Test
    fun aCalendarReminderEventDetailIsReadTheSameWay() {
        val reminder =
            parseCalendarReminder(
                """{"account":"a","event":"e","subject":"Standup","location":"","start":10,"all_day":false,"minutes":5}""",
            )
        assertEquals(CalendarReminder("a", "e", "Standup", null, 10, false, 5), reminder)
        assertEquals("calendar-reminder:a:e:10", reminder?.notificationKey)
        assertNull(parseCalendarReminder("""{"account":"a","event":"e"}"""), "no start, no reminder")
    }

    @Test
    fun theCoresLocalTimeIsKeptWhenItSaysOne() {
        val timed =
            parseCalendarReminder(
                """{"account":"a","event":"e","subject":"Standup","location":null,"start":10,"all_day":false,""" +
                    """"minutes":5,"local_time":"09:00","started":false,"local_date":null}""",
            )
        assertEquals(CalendarReminder("a", "e", "Standup", null, 10, false, 5, "09:00"), timed)
        val allDay =
            parseCalendarReminder(
                """{"account":"a","event":"d","subject":"Trip","start":10,"all_day":true,""" +
                    """"minutes":15,"local_time":null,"started":false,"local_date":"2026-10-21"}""",
            )
        assertEquals(CalendarReminder("a", "d", "Trip", null, 10, true, 15, null), allDay)
        assertNull(allDay?.localTime, "an all-day event has no time")
    }

    @Test
    fun paramsCarryWhatToReadAndLeaveOutAll() {
        assertEquals("""{"sync":true,"force":false}""", PimRefreshParams().toJson())
        assertEquals(
            """{"sync":true,"force":true,"only":"books"}""",
            PimRefreshParams(force = true, only = PimRefreshOnly.Books).toJson(),
        )
        assertEquals("""{"sync":false,"force":false}""", PimRefreshParams(sync = false).toJson())
        assertEquals("pim.refresh", MobileCommand.PimRefresh)
    }

    @Test
    fun theForegroundReadsOnTheFirstTickAndEveryQuarterHour() {
        assertTrue(pimRefreshTickSyncs(0))
        assertFalse(pimRefreshTickSyncs(1))
        assertFalse(pimRefreshTickSyncs(14))
        assertTrue(pimRefreshTickSyncs(15))
        assertEquals(15 * 60_000L, PIM_REFRESH_SYNC_EVERY_TICKS * PIM_REFRESH_TICK_MILLIS, "the core's calendar interval")
    }

    @Test
    fun theNetworkIsUsedOnlyWhereAutomaticCheckingIsOn() {
        assertTrue(pimRefreshMaySync(supportsBackgroundPush = true, pollIntervalMinutes = 0), "Android: its own rules")
        assertTrue(pimRefreshMaySync(supportsBackgroundPush = false, pollIntervalMinutes = 15))
        assertFalse(pimRefreshMaySync(supportsBackgroundPush = false, pollIntervalMinutes = 0), "iOS with polling off")
    }

    @Test
    fun aScreensProblemsAreRecordedClearedAndShownOneAtATime() {
        var errors = emptyMap<String, String>()
        assertNull(pimSyncNoticeOf(errors))
        errors = recordPimSyncError(errors, "g@gmail.com", "this account has not granted calendar access yet")
        assertEquals(PimSyncNotice(needsGoogleScope = true, message = "this account has not granted calendar access yet"), pimSyncNoticeOf(errors))
        errors = recordPimSyncError(errors, "ews@example.com", "calendar sync: 401 Unauthorized")
        assertEquals(PimSyncNotice(false, "calendar sync: 401 Unauthorized"), pimSyncNoticeOf(errors), "what a person can act on comes first")
        errors = recordPimSyncError(errors, "ews@example.com", null)
        assertEquals(setOf("g@gmail.com"), errors.keys, "a good read clears its own problem only")
        assertEquals(errors, recordPimSyncError(errors, "", "ignored"))
    }

    @Test
    fun aReminderBodySaysWhenAndWhere() {
        assertEquals("10:00 · Clinic", calendarReminderBody("10:00", "Clinic"))
        assertEquals("10:00", calendarReminderBody("10:00", null))
        assertEquals("Clinic", calendarReminderBody("", "Clinic"))
    }
}
