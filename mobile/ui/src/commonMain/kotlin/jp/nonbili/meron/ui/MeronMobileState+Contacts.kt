package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.AppPrefsGetParams
import jp.nonbili.meron.shared.MobileMailCommandClient
import jp.nonbili.meron.shared.MobilePeopleCommandClient
import jp.nonbili.meron.shared.PeopleListParams
import jp.nonbili.meron.shared.PersonSummary
import jp.nonbili.meron.shared.PersonWriteResult
import jp.nonbili.meron.shared.isUnknownCoreMethod
import jp.nonbili.meron.shared.parseAppPrefsResponse
import jp.nonbili.meron.shared.parsePeopleListResponse
import jp.nonbili.meron.shared.parsePersonWriteResponse
import jp.nonbili.meron.shared.requireCoreOk
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// The Contacts destination: the address book as the core keeps it, searched,
// read, and — for the local book and writable CardDAV books — written, with
// the same commands and version checks as the desktop
// (frontend/src/states/people.ts, ADR-0012).

private fun MeronMobileState.peopleClient() = MobilePeopleCommandClient(core)

internal fun MeronMobileState.openContactsScreen() {
    previousTopScreen = Screen.Contacts
    screen = Screen.Contacts
    refreshContactNamePrefs()
    loadPeople()
}

/**
 * Reads the desktop's name order and sort (ADR-0052). Asked on each opening,
 * since the desktop can change them at any time; a failed read keeps what was
 * known.
 */
private fun MeronMobileState.refreshContactNamePrefs() {
    if (!coreLoaded) return
    scope.launch {
        val response =
            runCatching {
                withContext(ioDispatcher) {
                    requireCoreOk(
                        MobileMailCommandClient(core).getPrefs(
                            AppPrefsGetParams(listOf(CONTACT_NAME_DISPLAY_SETTING_KEY, CONTACT_NAME_SORT_SETTING_KEY)),
                        ),
                    )
                }
            }.getOrNull() ?: return@launch
        val prefs = parseAppPrefsResponse(response)
        contactsUi.nameDisplay = contactNameDisplayFromSetting(prefs[CONTACT_NAME_DISPLAY_SETTING_KEY])
        contactsUi.nameSort = contactNameSortFromSetting(prefs[CONTACT_NAME_SORT_SETTING_KEY])
    }
}

/** Reads the book, or the part matching [query]. */
internal fun MeronMobileState.loadPeople(query: String = contactsUi.query) {
    val ui = contactsUi
    if (!coreLoaded) {
        ui.error = coreUnavailableMessage
        return
    }
    ui.loading = true
    scope.launch {
        runCatching {
            withContext(ioDispatcher) { peopleClient().list(PeopleListParams(query)) }
        }.onSuccess { response ->
            // A stale answer to an earlier query must not overwrite a newer one.
            if (ui.query != query) return@onSuccess
            ui.people = parsePeopleListResponse(response)
            ui.loaded = true
            ui.error = ""
            ui.unavailable = false
            ui.selected = ui.selected?.let { open -> ui.people.find { it.id == open.id } ?: open }
        }.onFailure {
            // An unreadable book is not an empty book: the list keeps what it had.
            if (ui.query != query) return@onFailure
            ui.unavailable = isUnknownCoreMethod(it.message)
            ui.error = it.message.orEmpty()
        }
        if (ui.query == query) ui.loading = false
    }
}

internal fun MeronMobileState.changeContactsQuery(query: String) {
    val ui = contactsUi
    ui.query = query
    ui.searchJob?.cancel()
    ui.searchJob =
        scope.launch {
            delay(250)
            loadPeople(query)
        }
}

internal fun MeronMobileState.startNewContact() {
    contactsUi.editing = ContactEditing()
}

internal fun MeronMobileState.startEditingContact(person: PersonSummary) {
    if (!person.editableOnMobile()) return
    contactsUi.editing = person.editing()
}

/**
 * Saves what the editor holds. On a conflict nothing is saved and the editor
 * stays open with the copy that is there now, for the reader to choose.
 */
internal fun MeronMobileState.saveContact(pending: ContactEditing? = null) {
    val ui = contactsUi
    val editing = pending ?: ui.editing ?: return
    if (!editing.draft.hasContent()) return
    ui.saving = true
    scope.launch {
        runCatching {
            withContext(ioDispatcher) { parsePersonWriteResponse(peopleClient().save(editing.saveParams())) }
        }.onSuccess { result ->
            ui.saving = false
            when (result) {
                is PersonWriteResult.Conflict -> {
                    ui.editing = editing.copy(conflict = ContactConflict(result.current))
                }

                is PersonWriteResult.Saved -> {
                    ui.editing = null
                    ui.selected = null
                    loadPeople()
                }
            }
        }.onFailure {
            ui.saving = false
            ui.error = it.message?.takeIf { message -> message.isNotBlank() } ?: trs("people.saveFailed")
        }
    }
}

/** After a conflict: this copy wins, saved from the version that is there now. */
internal fun MeronMobileState.keepMyContact() {
    val editing = contactsUi.editing ?: return
    saveContact(editing.keepingMine())
}

/** After a conflict: drop this copy and show the saved one. */
internal fun MeronMobileState.keepSavedContact() {
    contactsUi.editing = null
    loadPeople()
}

internal fun MeronMobileState.deleteContact(person: PersonSummary) {
    val ui = contactsUi
    ui.confirmingDelete = null
    scope.launch {
        runCatching {
            withContext(ioDispatcher) { parsePersonWriteResponse(peopleClient().delete(person.deleteParams())) }
        }.onSuccess { result ->
            if (result is PersonWriteResult.Conflict) {
                ui.error = trs("people.deleteConflict")
            } else {
                ui.selected = null
            }
            loadPeople()
        }.onFailure {
            ui.error = it.message?.takeIf { message -> message.isNotBlank() } ?: trs("people.deleteFailed")
        }
    }
}

/** Writes to someone from their card, through the ordinary composer. */
internal fun MeronMobileState.composeToContact(address: String) {
    openComposeTo(address, accountId = "", returnScreen = Screen.Contacts)
}
