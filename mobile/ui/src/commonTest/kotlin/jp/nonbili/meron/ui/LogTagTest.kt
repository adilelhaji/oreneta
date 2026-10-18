package jp.nonbili.meron.ui

import kotlin.test.Test
import kotlin.test.assertEquals

// Device log lines are tagged `Oreneta.*`, not Meron's name (#249).
class LogTagTest {
    @Test
    fun platformTagsCarryTheOrenetaPrefix() {
        assertEquals("Oreneta", LOG_TAG_PREFIX)
        assertEquals("Oreneta.OAuth", platformLogTag("OAuth"))
        assertEquals("Oreneta.MailLoad", platformLogTag("MailLoad"))
    }
}
