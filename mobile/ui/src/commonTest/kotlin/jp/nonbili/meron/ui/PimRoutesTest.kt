package jp.nonbili.meron.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class PimRoutesTest {
    @Test
    fun calendarAndContactsAreRoutesOfTheirOwn() {
        assertEquals("calendar", Screen.Calendar.route())
        assertEquals("contacts", Screen.Contacts.route())
        // Every screen's route leads back to it, so back navigation and a
        // restored back stack land where they left.
        for (screen in Screen.entries) assertEquals(screen, appRouteToScreen(screen.route()))
    }
}
