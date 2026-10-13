package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.PimRefreshReport
import jp.nonbili.meron.shared.PimSyncKind
import jp.nonbili.meron.shared.pimSyncNoticeOf
import jp.nonbili.meron.shared.recordPimSyncError

// What the Calendar and Contacts screens say about their background reads
// (ADR-0045): kept per account (calendars) or book (contacts), set by a
// failure and cleared by the next good read of the same one.

/** A screen's problems after a `pim.refresh` run: its failures recorded, the
 *  ones it read well cleared, everything else left as it was. */
internal fun pimSyncErrorsAfter(
    errors: Map<String, String>,
    report: PimRefreshReport,
    kind: PimSyncKind,
): Map<String, String> {
    val refreshed = if (kind == PimSyncKind.Calendar) report.calendarsRefreshed else report.booksRefreshed
    var next = refreshed.fold(errors) { acc, key -> recordPimSyncError(acc, key, null) }
    for (failure in report.failures.filter { it.kind == kind }) {
        next = recordPimSyncError(next, failure.key, failure.message)
    }
    return next
}

/** The banner for a screen's problems: a catalog key and its arguments.
 *  The missing Google permission gets its own sentence, since reconnecting
 *  (what the core suggests on the desktop) does not help on the phone. */
internal fun pimSyncBanner(
    errors: Map<String, String>,
    scopeKey: String,
    failedKey: String,
): Pair<String, Map<String, Any?>>? {
    val notice = pimSyncNoticeOf(errors) ?: return null
    return if (notice.needsGoogleScope) scopeKey to emptyMap() else failedKey to mapOf("message" to notice.message)
}

internal const val CALENDAR_SCOPE_MISSING_KEY = "mobile.calendar.googleScopeMissing"
internal const val CALENDAR_SYNC_FAILED_KEY = "mobile.calendar.syncFailed"
internal const val CONTACTS_SCOPE_MISSING_KEY = "mobile.contacts.googleScopeMissing"
internal const val CONTACTS_SYNC_FAILED_KEY = "mobile.contacts.syncFailed"
