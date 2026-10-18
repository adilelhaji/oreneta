package jp.nonbili.meron.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// The mobile About dialog matches desktop: this fork's source link, the
// attribution to Meron, and no donation links (#249).
class AboutContentTest {
    @Test
    fun sourceLinkPointsToThisRepository() {
        assertEquals("https://github.com/adilelhaji/oreneta", SOURCE_CODE_URL)
        assertFalse(SOURCE_CODE_URL.contains("nonbili"))
    }

    @Test
    fun attributionToMeronIsKept() {
        val attribution = localizedString("en", "about.forkOf")
        assertTrue(attribution.contains("Meron"), attribution)
        assertTrue(attribution.contains("AGPL-3.0"), attribution)
    }

    @Test
    fun donationStringsAreGoneFromTheCatalog() {
        // A missing key resolves to the key itself.
        for (key in listOf("about.donate", "about.githubSponsors", "about.liberapay", "about.paypal")) {
            assertEquals(key, localizedString("en", key))
        }
    }
}
