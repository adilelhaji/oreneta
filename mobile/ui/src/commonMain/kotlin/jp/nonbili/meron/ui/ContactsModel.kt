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

/** What to call someone in a list: their name, or else how to reach them. */
internal fun PersonSummary.displayLabel(): String =
    name.trim().ifBlank {
        emails.firstOrNull()?.addr ?: organisation.trim().ifBlank { phones.firstOrNull()?.number.orEmpty() }
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
