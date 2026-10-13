package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.CalendarReminder
import jp.nonbili.meron.shared.MobileMailCommandClient
import jp.nonbili.meron.shared.MobilePimRefreshClient
import jp.nonbili.meron.shared.PimRefreshOnly
import jp.nonbili.meron.shared.PimRefreshParams
import jp.nonbili.meron.shared.PimRefreshReport
import jp.nonbili.meron.shared.PimSyncKind
import jp.nonbili.meron.shared.accountSummaryIsRss
import jp.nonbili.meron.shared.calendarReminderBody
import jp.nonbili.meron.shared.parsePimRefreshResponse
import jp.nonbili.meron.shared.recordPimSyncError
import kotlinx.coroutines.withContext

// The periodic calendar and address-book refresh while the app is open, and
// the reminders it raises (`pim.refresh`, ADR-0045). MeronApp ticks this once
// a minute; the background refresh (WorkManager, BGAppRefreshTask) runs the
// same command after mail and posts its reminders itself. The core records a
// reminder before handing it over, so whichever asks first posts it, once.

/**
 * One run. With [params].sync the core reads the calendars and books that
 * are due; Google tokens the platform manages are minted first, as before
 * any other server command. Answers null when the core could not be asked.
 */
internal suspend fun MeronMobileState.runPimRefresh(params: PimRefreshParams): PimRefreshReport? {
    if (!coreLoaded) return null
    if (params.sync) {
        val mail = MobileMailCommandClient(core)
        coreAccounts
            .filter { !accountSummaryIsRss(it) && !it.paused && it.authType == "gmail_oauth" }
            .forEach { ensureManagedGoogleToken(mail, it.id) }
    }
    val report =
        runCatching {
            withContext(ioDispatcher) { parsePimRefreshResponse(MobilePimRefreshClient(core).refresh(params)) }
        }.getOrNull() ?: return null
    applyPimRefreshReport(report)
    return report
}

/** Posts the reminders and brings the screens up to date with what was read. */
internal fun MeronMobileState.applyPimRefreshReport(report: PimRefreshReport) {
    report.reminders.forEach(::postCalendarReminder)
    calendarUi.syncErrors = pimSyncErrorsAfter(calendarUi.syncErrors, report, PimSyncKind.Calendar)
    contactsUi.syncErrors = pimSyncErrorsAfter(contactsUi.syncErrors, report, PimSyncKind.AddressBook)
    if (report.booksRefreshed.isNotEmpty() && screen == Screen.Contacts) loadPeople()
}

private fun MeronMobileState.postCalendarReminder(reminder: CalendarReminder) {
    val time = if (reminder.allDay) trs("calendar.allDay") else formatDate(reminder.start * 1000, DateStyle.Time)
    mobileHost.notifyCalendarReminder(
        key = reminder.notificationKey,
        title = reminder.subject.ifBlank { trs("calendar.noSubject") },
        body = calendarReminderBody(time, reminder.location),
    )
}

/** The Contacts screen's refresh: its books read now, then the list again. */
internal suspend fun MeronMobileState.refreshAddressBooks() {
    contactsUi.loading = true
    runPimRefresh(PimRefreshParams(sync = true, force = true, only = PimRefreshOnly.Books))
    loadPeople()
}

/** A `calendar.syncError` event: a window refresh behind a read failed. */
internal fun MeronMobileState.noteCalendarSyncError(
    accountId: String,
    message: String,
) {
    calendarUi.syncErrors = recordPimSyncError(calendarUi.syncErrors, accountId, message.ifBlank { trs("calendar.staleWarning") })
}

/** A `calendar.synced` event: whatever that account last said is over. */
internal fun MeronMobileState.clearCalendarSyncError(accountId: String) {
    calendarUi.syncErrors = recordPimSyncError(calendarUi.syncErrors, accountId, null)
}
