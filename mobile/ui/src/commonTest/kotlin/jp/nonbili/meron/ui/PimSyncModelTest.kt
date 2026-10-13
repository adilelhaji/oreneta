package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.PimRefreshReport
import jp.nonbili.meron.shared.PimSyncFailure
import jp.nonbili.meron.shared.PimSyncKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PimSyncModelTest {
    private val scope = "this account has not granted access to its contacts yet — reconnect it"

    @Test
    fun aRunRecordsItsOwnKindsFailuresAndClearsWhatItReadWell() {
        val before = mapOf("ews@example.com" to "calendar sync: timed out", "other@example.com" to "calendar sync: 500")
        val report =
            PimRefreshReport(
                calendarsRefreshed = listOf("ews@example.com"),
                booksRefreshed = listOf("carddav-1"),
                failures =
                    listOf(
                        PimSyncFailure(PimSyncKind.Calendar, "g@gmail.com", "g@gmail.com", "calendar sync: 403"),
                        PimSyncFailure(PimSyncKind.AddressBook, "google-g@gmail.com", "g@gmail.com", scope),
                    ),
            )
        assertEquals(
            mapOf("other@example.com" to "calendar sync: 500", "g@gmail.com" to "calendar sync: 403"),
            pimSyncErrorsAfter(before, report, PimSyncKind.Calendar),
            "an account not read this run keeps its problem",
        )
        assertEquals(
            mapOf("google-g@gmail.com" to scope),
            pimSyncErrorsAfter(mapOf("carddav-1" to "401"), report, PimSyncKind.AddressBook),
        )
    }

    @Test
    fun theBannerNamesTheMissingPermissionOrRepeatsTheServer() {
        assertNull(pimSyncBanner(emptyMap(), CONTACTS_SCOPE_MISSING_KEY, CONTACTS_SYNC_FAILED_KEY))
        assertEquals(
            CONTACTS_SCOPE_MISSING_KEY to emptyMap<String, Any?>(),
            pimSyncBanner(mapOf("google-g" to scope), CONTACTS_SCOPE_MISSING_KEY, CONTACTS_SYNC_FAILED_KEY),
        )
        assertEquals(
            CALENDAR_SYNC_FAILED_KEY to mapOf<String, Any?>("message" to "calendar sync: 500"),
            pimSyncBanner(mapOf("a" to "calendar sync: 500"), CALENDAR_SCOPE_MISSING_KEY, CALENDAR_SYNC_FAILED_KEY),
        )
    }
}
