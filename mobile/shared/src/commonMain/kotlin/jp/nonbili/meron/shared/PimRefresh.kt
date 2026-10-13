package jp.nonbili.meron.shared

// The phone's periodic calendar and address-book refresh, and the calendar
// reminders it raises: `pim.refresh` (meron-core/src/pim/refresh.rs, ADR-0045).
// The core decides what is due and records each reminder as raised before it
// answers, so whoever asks — the foreground tick or the background refresh —
// posts what it is handed and nothing is given twice.

/** How often the foreground asks: the desktop's reminder watch ticks once a minute too. */
const val PIM_REFRESH_TICK_MILLIS = 60_000L

/** Every how many ticks the foreground also lets the core read what is due
 *  (it decides what that is: calendars every 15 minutes, books hourly). The
 *  ticks between only look for reminders, which need no network and no
 *  fresh Google token. */
const val PIM_REFRESH_SYNC_EVERY_TICKS = 15L

/** Whether foreground tick [tick] (0 on the screen's first) may read. */
fun pimRefreshTickSyncs(tick: Long): Boolean = tick % PIM_REFRESH_SYNC_EVERY_TICKS == 0L

/** Which of the two a run reads. */
enum class PimRefreshOnly(
    val wire: String?,
) {
    All(null),
    Calendars("calendars"),
    Books("books"),
}

data class PimRefreshParams(
    /** False only looks for reminders: nothing goes to the network. */
    val sync: Boolean = true,
    /** Reads even what is not yet due (a person pressed refresh). */
    val force: Boolean = false,
    val only: PimRefreshOnly = PimRefreshOnly.All,
) {
    fun toJson(): String =
        jsonObject(
            "sync" to sync.toString(),
            "force" to force.toString(),
            "only" to only.wire?.jsonString(),
        )
}

/** A reminder that came due: the desktop's `calendar.reminder` detail. */
data class CalendarReminder(
    val accountId: String,
    val eventId: String,
    val subject: String = "",
    val location: String? = null,
    val start: Long,
    val allDay: Boolean = false,
    val minutes: Long? = null,
) {
    /** Stable per event and start, so a platform that is handed the same
     *  reminder twice replaces its notification rather than adding one. */
    val notificationKey: String get() = "calendar-reminder:$accountId:$eventId:$start"
}

enum class PimSyncKind { Calendar, AddressBook }

/** One calendar account or book a run could not read. */
data class PimSyncFailure(
    val kind: PimSyncKind,
    /** The account for a calendar; the book's id for an address book. */
    val key: String,
    val accountId: String,
    val message: String,
)

data class PimRefreshReport(
    val reminders: List<CalendarReminder> = emptyList(),
    /** Calendar accounts read well this run. */
    val calendarsRefreshed: List<String> = emptyList(),
    /** Books read well this run. */
    val booksRefreshed: List<String> = emptyList(),
    val failures: List<PimSyncFailure> = emptyList(),
)

fun parsePimRefreshResponse(responseJson: String): PimRefreshReport {
    val entries = responseJson.coreResultEntries()
    val reminders =
        entries["reminders"]
            ?.takeIf { it.startsWith("[") }
            ?.jsonArrayValues()
            ?.mapNotNull(::parseCalendarReminder)
            .orEmpty()
    val calendarsRefreshed = mutableListOf<String>()
    val booksRefreshed = mutableListOf<String>()
    val failures = mutableListOf<PimSyncFailure>()
    entries["calendars"]?.takeIf { it.startsWith("[") }?.jsonArrayValues()?.forEach { item ->
        val row = item.topLevelJsonEntries()
        val account = row.string("account").orEmpty()
        if (account.isBlank()) return@forEach
        if (row.bool("ok") == true) {
            calendarsRefreshed += account
        } else {
            failures += PimSyncFailure(PimSyncKind.Calendar, account, account, row.string("error").orEmpty())
        }
    }
    entries["books"]?.takeIf { it.startsWith("[") }?.jsonArrayValues()?.forEach { item ->
        val row = item.topLevelJsonEntries()
        val id = row.string("id").orEmpty()
        if (id.isBlank()) return@forEach
        if (row.bool("ok") == true) {
            booksRefreshed += id
        } else {
            failures += PimSyncFailure(PimSyncKind.AddressBook, id, row.string("account").orEmpty(), row.string("error").orEmpty())
        }
    }
    return PimRefreshReport(reminders, calendarsRefreshed, booksRefreshed, failures)
}

/** One reminder object (a `pim.refresh` entry or a `calendar.reminder` detail). */
fun parseCalendarReminder(json: String): CalendarReminder? {
    if (!json.trim().startsWith("{")) return null
    val entries = json.topLevelJsonEntries()
    val accountId = entries.string("account").orEmpty()
    val eventId = entries.string("event").orEmpty()
    val start = entries.long("start") ?: return null
    if (accountId.isBlank() || eventId.isBlank()) return null
    return CalendarReminder(
        accountId = accountId,
        eventId = eventId,
        subject = entries.string("subject").orEmpty(),
        location = entries.string("location")?.takeIf { it.isNotBlank() },
        start = start,
        allDay = entries.bool("all_day") ?: false,
        minutes = entries.long("minutes"),
    )
}

/**
 * Whether a sync failed because the Google sign-in never granted calendar or
 * contacts access. The phone's Google sign-in asks for mail only, so
 * reconnecting — what the core's message suggests on the desktop — does not
 * help here; the screens say so instead.
 */
fun pimSyncNeedsGoogleScope(message: String): Boolean = message.contains("has not granted")

/**
 * Whether the periodic refresh may go to the network. Reminders are always
 * looked for (they need none). Where the platform has no real background
 * channel (iOS), the person's poll interval governs every automatic check,
 * mail's included, and "Off" turns this one off too.
 */
fun pimRefreshMaySync(
    supportsBackgroundPush: Boolean,
    pollIntervalMinutes: Int,
): Boolean = supportsBackgroundPush || pollIntervalMinutes > 0

/**
 * A screen's sync problems, keyed by account (calendars) or book: a failure
 * records its message, a later good read of the same key clears it.
 */
fun recordPimSyncError(
    errors: Map<String, String>,
    key: String,
    message: String?,
): Map<String, String> =
    when {
        key.isBlank() -> errors
        message.isNullOrBlank() -> errors - key
        else -> errors + (key to message)
    }

/** What a screen shows for its recorded problems, if anything. */
data class PimSyncNotice(
    val needsGoogleScope: Boolean,
    /** The core's own words, for a problem that is not the missing scope. */
    val message: String,
)

/**
 * One notice for a screen. A problem a person can act on (a server's own
 * answer) is shown before the missing-scope one, which only an update of
 * the app can fix.
 */
fun pimSyncNoticeOf(errors: Map<String, String>): PimSyncNotice? {
    if (errors.isEmpty()) return null
    val actionable = errors.values.firstOrNull { !pimSyncNeedsGoogleScope(it) }
    return if (actionable != null) PimSyncNotice(false, actionable) else PimSyncNotice(true, errors.values.first())
}

/** The line under a reminder's title: when, and where if it says. */
fun calendarReminderBody(
    timeText: String,
    location: String?,
): String = listOf(timeText, location.orEmpty()).filter { it.isNotBlank() }.joinToString(" · ")

class MobilePimRefreshClient(
    private val core: MeronCore,
) {
    suspend fun refresh(params: PimRefreshParams): String = requireCoreOk(core.invoke(MobileCommand.PimRefresh, params.toJson()))
}
