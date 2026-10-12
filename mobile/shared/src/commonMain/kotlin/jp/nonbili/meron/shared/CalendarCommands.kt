package jp.nonbili.meron.shared

// Calendar, through the same core commands the desktop uses (calendar.go and
// frontend/src/states/calendar.ts). The core owns the calendars, the cache and
// the sync; this side only carries requests and reads answers.
//
// Two things the desktop can do are deliberately left out here: telling the
// people on an event (`notify` is always false), and changing a whole series
// (`scope` is always "occurrence", which is also what the core assumes when
// nobody says).

/** Where a calendar comes from: "account", "local", "subscribed" or "caldav". */
data class CalendarSummary(
    val id: String,
    val name: String,
    val isDefault: Boolean = false,
    val enabled: Boolean = true,
    val color: String? = null,
    val kind: String = "account",
    val url: String? = null,
    val readOnly: Boolean = false,
    val syncedAt: Long = 0,
    // Not sent by the core: it answers per account, so this is stamped on
    // when the answer is read, as the desktop does.
    val accountId: String = "",
)

data class CalendarParticipant(
    val name: String = "",
    val addr: String = "",
    /** "accept", "decline", "tentative", "none", or empty. */
    val response: String = "",
)

data class OnlineMeeting(
    val provider: String,
    val url: String,
)

/** One occurrence, as `calendar.events` answers it. Times are epoch seconds. */
data class CalendarEvent(
    val id: String,
    val calendarId: String,
    val changeKey: String? = null,
    val subject: String = "",
    val location: String? = null,
    val start: Long,
    val end: Long,
    val allDay: Boolean = false,
    val isRecurring: Boolean = false,
    val reminderMinutes: Long? = null,
    val description: String = "",
    val seriesId: String? = null,
    val isCancelled: Boolean = false,
    val freeBusy: String = "",
    val myResponse: String = "",
    val organizer: CalendarParticipant? = null,
    val attendees: List<CalendarParticipant> = emptyList(),
    val meeting: OnlineMeeting? = null,
    // Stamped on when read, like [CalendarSummary.accountId]; never sent.
    val accountId: String = "",
) {
    /**
     * The event as the core's `calendar::Event` reads it. Absent fields are
     * left out rather than sent as null, which serde reads the same way.
     * `recurrence` is never sent: mobile creates single events only.
     */
    fun toCoreJson(): String =
        jsonObject(
            "id" to id.jsonString(),
            "calendar_id" to calendarId.jsonString(),
            "change_key" to changeKey?.jsonString(),
            "subject" to subject.jsonString(),
            "location" to location?.jsonString(),
            "start" to start.toString(),
            "end" to end.toString(),
            "all_day" to allDay.toString(),
            "is_recurring" to isRecurring.toString(),
            "reminder_minutes" to reminderMinutes?.toString(),
            "description" to description.jsonString(),
            "series_id" to seriesId?.jsonString(),
            "is_cancelled" to isCancelled.toString(),
            "free_busy" to freeBusy.jsonString(),
            "my_response" to myResponse.jsonString(),
            "organizer" to organizer?.toCoreJson(),
            "attendees" to attendees.joinToString(",", "[", "]") { it.toCoreJson() },
            "meeting" to meeting?.let { jsonObject("provider" to it.provider.jsonString(), "url" to it.url.jsonString()) },
        )
}

private fun CalendarParticipant.toCoreJson(): String =
    jsonObject(
        "name" to name.jsonString(),
        "addr" to addr.jsonString(),
        "response" to response.jsonString(),
    )

/** What `calendar.eventDetails` adds to a cached occurrence. */
data class CalendarEventDetails(
    val attendees: List<CalendarParticipant>,
    val description: String,
)

data class CalendarListParams(
    val accountId: String,
) {
    fun toJson(): String = jsonObject("account" to accountId.jsonString())
}

data class CalendarSetEnabledParams(
    val accountId: String,
    val calendarId: String,
    val enabled: Boolean,
) {
    fun toJson(): String =
        jsonObject(
            "account" to accountId.jsonString(),
            "calendar" to calendarId.jsonString(),
            "enabled" to enabled.toString(),
        )
}

/** A half-open window [from, to) in epoch seconds. */
data class CalendarEventsParams(
    val accountId: String,
    val from: Long,
    val to: Long,
    // Answer from the cache and refresh behind the request, as the desktop's
    // default; false only for a reload that a sync event itself caused.
    val refresh: Boolean = true,
) {
    fun toJson(): String =
        jsonObject(
            "account" to accountId.jsonString(),
            "from" to from.toString(),
            "to" to to.toString(),
            "refresh" to refresh.toString(),
        )
}

data class CalendarEventDetailsParams(
    val accountId: String,
    val calendarId: String,
    val eventId: String,
    val changeKey: String = "",
) {
    fun toJson(): String =
        jsonObject(
            "account" to accountId.jsonString(),
            "calendar" to calendarId.jsonString(),
            "event" to eventId.jsonString(),
            "change_key" to changeKey.jsonString(),
        )
}

/** A new event; the core assigns its id. Nobody is told. */
data class CalendarCreateParams(
    val event: CalendarEvent,
) {
    fun toJson(): String =
        jsonObject(
            "account" to event.accountId.jsonString(),
            "event" to event.toCoreJson(),
            "notify" to "false",
        )
}

/** A changed occurrence, carrying the change key it was read with. Nobody is told. */
data class CalendarUpdateParams(
    val event: CalendarEvent,
) {
    fun toJson(): String =
        jsonObject(
            "account" to event.accountId.jsonString(),
            "event" to event.toCoreJson(),
            "scope" to MOBILE_CALENDAR_SCOPE.jsonString(),
            "notify" to "false",
        )
}

/** Deletes one occurrence. Nobody is told. */
data class CalendarDeleteParams(
    val event: CalendarEvent,
) {
    fun toJson(): String =
        jsonObject(
            "account" to event.accountId.jsonString(),
            "event" to event.id.jsonString(),
            // Exchange finds an event by its own id; Google needs the
            // calendar holding it.
            "calendar" to event.calendarId.jsonString(),
            "change_key" to event.changeKey.orEmpty().jsonString(),
            "series" to event.seriesId.orEmpty().jsonString(),
            "scope" to MOBILE_CALENDAR_SCOPE.jsonString(),
            "notify" to "false",
        )
}

/** The only edit scope mobile offers: the occurrence in hand. */
const val MOBILE_CALENDAR_SCOPE = "occurrence"

class MobileCalendarCommandClient(
    private val core: MeronCore,
) {
    suspend fun listCalendars(params: CalendarListParams): String = requireCoreOk(core.invoke(MobileCommand.CalendarList, params.toJson()))

    suspend fun setEnabled(params: CalendarSetEnabledParams): String = requireCoreOk(core.invoke(MobileCommand.CalendarSetEnabled, params.toJson()))

    suspend fun events(params: CalendarEventsParams): String = requireCoreOk(core.invoke(MobileCommand.CalendarEvents, params.toJson()))

    suspend fun eventDetails(params: CalendarEventDetailsParams): String = requireCoreOk(core.invoke(MobileCommand.CalendarEventDetails, params.toJson()))

    suspend fun create(params: CalendarCreateParams): String = requireCoreOk(core.invoke(MobileCommand.CalendarCreate, params.toJson()))

    suspend fun update(params: CalendarUpdateParams): String = requireCoreOk(core.invoke(MobileCommand.CalendarUpdate, params.toJson()))

    suspend fun delete(params: CalendarDeleteParams): String = requireCoreOk(core.invoke(MobileCommand.CalendarDelete, params.toJson()))
}

/**
 * True when the core answered that it does not know [message]'s command at
 * all — a core built without it — rather than that the command failed.
 */
fun isUnknownCoreMethod(message: String?): Boolean = message?.startsWith("unknown method") == true

fun parseCalendarListResponse(
    responseJson: String,
    accountId: String,
): List<CalendarSummary> {
    val list = responseJson.coreResultEntries()["calendars"] ?: return emptyList()
    if (!list.startsWith("[")) return emptyList()
    return list.jsonArrayValues().mapNotNull { item ->
        val entries = item.topLevelJsonEntries()
        val id = entries.string("id").orEmpty()
        if (id.isBlank()) return@mapNotNull null
        CalendarSummary(
            id = id,
            name = entries.string("name").orEmpty(),
            isDefault = entries.bool("is_default") ?: false,
            enabled = entries.bool("enabled") ?: true,
            color = entries.string("color")?.takeIf { it.isNotBlank() },
            kind = entries.string("kind")?.takeIf { it.isNotBlank() } ?: "account",
            url = entries.string("url")?.takeIf { it.isNotBlank() },
            readOnly = entries.bool("read_only") ?: false,
            syncedAt = entries.long("synced_at") ?: 0,
            accountId = accountId,
        )
    }
}

fun parseCalendarEventsResponse(
    responseJson: String,
    accountId: String,
): List<CalendarEvent> {
    val list = responseJson.coreResultEntries()["events"] ?: return emptyList()
    if (!list.startsWith("[")) return emptyList()
    return list.jsonArrayValues().mapNotNull { item -> parseCalendarEvent(item, accountId) }
}

/** One event object, or null when it lacks what an occurrence must have. */
fun parseCalendarEvent(
    eventJson: String,
    accountId: String,
): CalendarEvent? {
    val entries = eventJson.topLevelJsonEntries()
    val id = entries.string("id").orEmpty()
    val start = entries.long("start") ?: return null
    if (id.isBlank()) return null
    return CalendarEvent(
        id = id,
        calendarId = entries.string("calendar_id").orEmpty(),
        changeKey = entries.string("change_key"),
        subject = entries.string("subject").orEmpty(),
        location = entries.string("location"),
        start = start,
        end = entries.long("end") ?: start,
        allDay = entries.bool("all_day") ?: false,
        isRecurring = entries.bool("is_recurring") ?: false,
        reminderMinutes = entries.long("reminder_minutes"),
        description = entries.string("description").orEmpty(),
        seriesId = entries.string("series_id"),
        isCancelled = entries.bool("is_cancelled") ?: false,
        freeBusy = entries.string("free_busy").orEmpty(),
        myResponse = entries.string("my_response").orEmpty(),
        organizer = entries["organizer"]?.takeIf { it.startsWith("{") }?.let(::parseParticipant),
        attendees = parseParticipants(entries["attendees"]),
        meeting =
            entries["meeting"]?.takeIf { it.startsWith("{") }?.topLevelJsonEntries()?.let { meeting ->
                val url = meeting.string("url").orEmpty()
                if (url.isBlank()) null else OnlineMeeting(meeting.string("provider").orEmpty(), url)
            },
        accountId = accountId,
    )
}

fun parseCalendarEventDetailsResponse(responseJson: String): CalendarEventDetails {
    val entries = responseJson.coreResultEntries()
    return CalendarEventDetails(
        attendees = parseParticipants(entries["attendees"]),
        description = entries.string("description").orEmpty(),
    )
}

private fun parseParticipants(listJson: String?): List<CalendarParticipant> =
    listJson
        ?.takeIf { it.startsWith("[") }
        ?.jsonArrayValues()
        ?.filter { it.startsWith("{") }
        ?.map(::parseParticipant)
        .orEmpty()

private fun parseParticipant(json: String): CalendarParticipant {
    val entries = json.topLevelJsonEntries()
    return CalendarParticipant(
        name = entries.string("name").orEmpty(),
        addr = entries.string("addr").orEmpty(),
        response = entries.string("response").orEmpty(),
    )
}

/**
 * The top-level entries of a core answer. The platform cores hand back the
 * whole `{"id":…,"result":{…}}` envelope; a bare result is read as it is.
 */
internal fun String.coreResultEntries(): Map<String, String> {
    val entries = trim().takeIf { it.startsWith("{") }?.topLevelJsonEntries() ?: return emptyMap()
    val result = entries["result"]
    return if (result != null && result.startsWith("{") && "id" in entries) result.topLevelJsonEntries() else entries
}

internal fun Map<String, String>.string(key: String): String? = get(key)?.decodeJsonString()

internal fun Map<String, String>.bool(key: String): Boolean? =
    when (get(key)) {
        "true" -> true
        "false" -> false
        else -> null
    }

internal fun Map<String, String>.long(key: String): Long? = get(key)?.toLongOrNull()
