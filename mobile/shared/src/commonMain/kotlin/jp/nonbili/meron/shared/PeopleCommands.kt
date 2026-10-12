package jp.nonbili.meron.shared

// The address book, through the same core commands the desktop uses
// (people.go and frontend/src/states/people.ts, ADR-0012). The core decides
// which books can be written to and checks every write against the version it
// was read at; this side only carries requests and reads answers.

data class PersonEmail(
    val addr: String,
    val label: String = "",
)

data class PersonPhone(
    val number: String,
    val label: String = "",
)

/** One person as `people.list` answers. */
data class PersonSummary(
    val id: String,
    /** "local", "carddav", "google" or "exchange". */
    val source: String = "local",
    /** The account whose book they are in; empty for a book that is nobody's. */
    val account: String = "",
    val book: String = "",
    val name: String = "",
    val organisation: String = "",
    val note: String = "",
    /** Media key of their picture; empty when none. */
    val photo: String = "",
    val emails: List<PersonEmail> = emptyList(),
    val phones: List<PersonPhone> = emptyList(),
    /** The version it was read at; a write names it. */
    val version: String = "",
    /** Whether the core lets this book be written from here. */
    val editable: Boolean = false,
    /** The reader's link to the same person in other books, if any. */
    val link: String? = null,
)

/** The fields an edit sends, as the core's `PersonInput` reads them. */
data class PersonDraft(
    val name: String = "",
    val organisation: String = "",
    val note: String = "",
    val emails: List<PersonEmail> = emptyList(),
    val phones: List<PersonPhone> = emptyList(),
) {
    fun toJson(): String =
        jsonObject(
            "name" to name.jsonString(),
            "organisation" to organisation.jsonString(),
            "note" to note.jsonString(),
            "emails" to emails.joinToString(",", "[", "]") { jsonObject("addr" to it.addr.jsonString(), "label" to it.label.jsonString()) },
            "phones" to phones.joinToString(",", "[", "]") { jsonObject("number" to it.number.jsonString(), "label" to it.label.jsonString()) },
        )
}

data class PeopleListParams(
    val query: String = "",
    // What the desktop asks for: enough for a whole book, small enough to
    // read in one answer.
    val limit: Int = 2000,
) {
    fun toJson(): String = jsonObject("query" to query.jsonString(), "limit" to limit.toString())
}

/**
 * Creates a person (no [id]) or edits one from the [version] it was read at.
 * A new person goes to the local book unless [book] names a server book.
 */
data class PeopleSaveParams(
    val id: String? = null,
    val version: String? = null,
    val book: String? = null,
    val person: PersonDraft,
) {
    fun toJson(): String {
        val editing = !id.isNullOrBlank()
        return jsonObject(
            "id" to id?.takeIf { editing }?.jsonString(),
            // The core refuses an edit that does not say which version it
            // was made from; the desktop sends an empty one when unknown.
            "version" to version.orEmpty().takeIf { editing }?.jsonString(),
            "book" to book?.takeIf { !editing && it.isNotBlank() }?.jsonString(),
            "person" to person.toJson(),
        )
    }
}

data class PeopleDeleteParams(
    val id: String,
    val version: String,
) {
    fun toJson(): String = jsonObject("id" to id.jsonString(), "version" to version.jsonString())
}

/** How a write went. A conflict saved nothing. */
sealed interface PersonWriteResult {
    data class Saved(
        val id: String,
        val version: String,
    ) : PersonWriteResult

    /** Changed elsewhere since it was read; [current] is what is there now, null if it was deleted. */
    data class Conflict(
        val current: PersonSummary?,
    ) : PersonWriteResult
}

class MobilePeopleCommandClient(
    private val core: MeronCore,
) {
    suspend fun list(params: PeopleListParams): String = requireCoreOk(core.invoke(MobileCommand.PeopleList, params.toJson()))

    suspend fun save(params: PeopleSaveParams): String = requireCoreOk(core.invoke(MobileCommand.PeopleSave, params.toJson()))

    suspend fun delete(params: PeopleDeleteParams): String = requireCoreOk(core.invoke(MobileCommand.PeopleDelete, params.toJson()))
}

fun parsePeopleListResponse(responseJson: String): List<PersonSummary> {
    val list = responseJson.coreResultEntries()["people"] ?: return emptyList()
    if (!list.startsWith("[")) return emptyList()
    return list.jsonArrayValues().mapNotNull(::parsePerson)
}

fun parsePersonWriteResponse(responseJson: String): PersonWriteResult {
    val entries = responseJson.coreResultEntries()
    if (entries.bool("conflict") == true) {
        return PersonWriteResult.Conflict(entries["current"]?.takeIf { it.startsWith("{") }?.let(::parsePerson))
    }
    return PersonWriteResult.Saved(id = entries.string("id").orEmpty(), version = entries.string("version").orEmpty())
}

private fun parsePerson(json: String): PersonSummary? {
    val entries = json.topLevelJsonEntries()
    val id = entries.string("id").orEmpty()
    if (id.isBlank()) return null
    return PersonSummary(
        id = id,
        source = entries.string("source")?.takeIf { it.isNotBlank() } ?: "local",
        account = entries.string("account").orEmpty(),
        book = entries.string("book").orEmpty(),
        name = entries.string("name").orEmpty(),
        organisation = entries.string("organisation").orEmpty(),
        note = entries.string("note").orEmpty(),
        photo = entries.string("photo").orEmpty(),
        emails =
            entries["emails"].objects().mapNotNull { item ->
                val addr = item.string("addr").orEmpty()
                if (addr.isBlank()) null else PersonEmail(addr, item.string("label").orEmpty())
            },
        phones =
            entries["phones"].objects().mapNotNull { item ->
                val number = item.string("number").orEmpty()
                if (number.isBlank()) null else PersonPhone(number, item.string("label").orEmpty())
            },
        version = entries.string("version").orEmpty(),
        editable = entries.bool("editable") ?: false,
        link = entries.string("link")?.takeIf { it.isNotBlank() },
    )
}

private fun String?.objects(): List<Map<String, String>> =
    this
        ?.takeIf { it.startsWith("[") }
        ?.jsonArrayValues()
        ?.filter { it.startsWith("{") }
        ?.map { it.topLevelJsonEntries() }
        .orEmpty()
