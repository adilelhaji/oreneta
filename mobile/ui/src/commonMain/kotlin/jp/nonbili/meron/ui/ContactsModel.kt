package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.PeopleDeleteParams
import jp.nonbili.meron.shared.PeopleSaveParams
import jp.nonbili.meron.shared.PersonDraft
import jp.nonbili.meron.shared.PersonEmail
import jp.nonbili.meron.shared.PersonPhone
import jp.nonbili.meron.shared.PersonSummary

// The address book's rules, kept free of Compose so they can be tested as they
// are. They follow frontend/src/states/people.ts and ADR-0012.

/**
 * Whether this person can be changed from here: the core says which books it
 * writes to (the local one, and CardDAV books the server has not marked
 * read-only), and Google and directory books never are.
 */
internal fun PersonSummary.editableOnMobile(): Boolean = editable && (source == "local" || source == "carddav")

/** The catalog key naming where a person came from. */
internal fun PersonSummary.sourceKey(): String =
    when (source) {
        "carddav", "google", "exchange" -> "people.source.$source"
        else -> "people.source.local"
    }

/**
 * The list as the reader sees it: people linked as one show once, by the
 * first of them in the list's order.
 */
internal fun collapseLinked(people: List<PersonSummary>): List<PersonSummary> {
    val seen = mutableSetOf<String>()
    return people.filter { person ->
        val link = person.link ?: return@filter true
        seen.add(link)
    }
}

/**
 * Core `settings` rows the desktop's Contacts → General writes (ADR-0052):
 * how names with known parts are written, and which part the list is ordered
 * by. Shared with the desktop, like [CALENDAR_WEEK_START_SETTING_KEY].
 */
internal const val CONTACT_NAME_DISPLAY_SETTING_KEY = "contact_name_display"
internal const val CONTACT_NAME_SORT_SETTING_KEY = "contact_name_sort"

/**
 * How a name is written. [AsWritten] is the desktop's "auto": common code has
 * no regional name order, so the phone then shows the book's whole name.
 */
internal enum class ContactNameDisplay { AsWritten, FirstLast, LastCommaFirst, LastFirst }

/** Which part the list is ordered by; [Name] (the desktop's "auto") is the whole name. */
internal enum class ContactNameSort { Name, First, Last }

internal fun contactNameDisplayFromSetting(value: Any?): ContactNameDisplay =
    when (value) {
        "first_last" -> ContactNameDisplay.FirstLast
        "last_comma_first" -> ContactNameDisplay.LastCommaFirst
        "last_first" -> ContactNameDisplay.LastFirst
        else -> ContactNameDisplay.AsWritten
    }

internal fun contactNameSortFromSetting(value: Any?): ContactNameSort =
    when (value) {
        "first" -> ContactNameSort.First
        "last" -> ContactNameSort.Last
        else -> ContactNameSort.Name
    }

// Han, kana and hangul: written without a space between the two names.
private fun Char.isCjk(): Boolean =
    this in '\u3040'..'\u30ff' || this in '\u3400'..'\u4dbf' || this in '\u4e00'..'\u9fff' ||
        this in '\uac00'..'\ud7af' || this in '\uf900'..'\ufaff'

/**
 * The name as the reader chose to see names. Only a name the book keeps in
 * both parts is reordered; a whole name is never split by guessing.
 */
internal fun PersonSummary.orderedName(display: ContactNameDisplay): String {
    val given = given.trim()
    val family = family.trim()
    if (given.isEmpty() || family.isEmpty()) return name.trim()
    return when (display) {
        ContactNameDisplay.AsWritten -> name.trim().ifBlank { "$given $family" }
        ContactNameDisplay.FirstLast -> "$given $family"
        ContactNameDisplay.LastCommaFirst -> "$family, $given"
        ContactNameDisplay.LastFirst -> if (family.any { it.isCjk() } && given.any { it.isCjk() }) "$family$given" else "$family $given"
    }
}

/** What to call someone in a list: their name, or else how to reach them. */
internal fun PersonSummary.displayLabel(display: ContactNameDisplay = ContactNameDisplay.AsWritten): String =
    orderedName(display).ifBlank {
        emails.firstOrNull()?.addr ?: organisation.trim().ifBlank { phones.firstOrNull()?.number.orEmpty() }
    }

/** The list in the reader's order: by the chosen part, then by whole name. */
internal fun sortedForList(
    people: List<PersonSummary>,
    sort: ContactNameSort,
): List<PersonSummary> {
    if (sort == ContactNameSort.Name) return people

    fun key(person: PersonSummary): String {
        val given = person.given.trim()
        val family = person.family.trim()
        val chosen =
            when (sort) {
                ContactNameSort.Last -> if (family.isNotEmpty()) "$family $given" else ""
                else -> if (given.isNotEmpty()) "$given $family" else ""
            }
        return chosen.ifBlank { person.displayLabel() }.lowercase()
    }
    return people.sortedWith(compareBy<PersonSummary>({ key(it) }, { it.name.lowercase() }))
}

internal fun PersonSummary.toDraft(): PersonDraft =
    PersonDraft(
        name = name,
        organisation = organisation,
        note = note,
        emails = emails,
        phones = phones,
    )

/** The draft a new contact starts from: one empty address to type into. */
internal fun emptyPersonDraft(): PersonDraft = PersonDraft(emails = listOf(PersonEmail("")))

/** Trimmed, with the empty address and phone rows the editor offers left out. */
internal fun PersonDraft.cleaned(): PersonDraft =
    PersonDraft(
        name = name.trim(),
        organisation = organisation.trim(),
        note = note.trim(),
        emails = emails.map { PersonEmail(it.addr.trim(), it.label.trim()) }.filter { it.addr.isNotEmpty() },
        phones = phones.map { PersonPhone(it.number.trim(), it.label.trim()) }.filter { it.number.isNotEmpty() },
    )

/** A contact with nothing in it is not worth saving. */
internal fun PersonDraft.hasContent(): Boolean = cleaned().let { it.name.isNotEmpty() || it.organisation.isNotEmpty() || it.emails.isNotEmpty() || it.phones.isNotEmpty() }

/**
 * The editor: a person being written, and which copy they were read from.
 * New contacts go to the local book on this device.
 */
internal data class ContactEditing(
    /** Absent for a new person. */
    val id: String? = null,
    /** The version the draft was read at; absent for a new person. */
    val version: String? = null,
    val draft: PersonDraft = emptyPersonDraft(),
    /**
     * Set when saving found the person changed elsewhere: nothing was saved,
     * and this is the copy there now (null inside when it was deleted).
     */
    val conflict: ContactConflict? = null,
) {
    val isNew: Boolean get() = id.isNullOrBlank()

    fun saveParams(): PeopleSaveParams = PeopleSaveParams(id = id, version = version, person = draft.cleaned())

    /**
     * Keeps this copy over the one saved elsewhere: saved again from the
     * version there now, or created again if it was deleted.
     */
    fun keepingMine(): ContactEditing {
        val current = conflict?.current
        return if (current != null) copy(version = current.version, conflict = null) else ContactEditing(draft = draft)
    }
}

internal data class ContactConflict(
    val current: PersonSummary?,
)

internal fun PersonSummary.editing(): ContactEditing = ContactEditing(id = id, version = version, draft = toDraft())

internal fun PersonSummary.deleteParams(): PeopleDeleteParams = PeopleDeleteParams(id = id, version = version)
