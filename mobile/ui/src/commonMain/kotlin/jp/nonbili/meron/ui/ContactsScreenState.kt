package jp.nonbili.meron.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import jp.nonbili.meron.shared.PersonSummary
import kotlinx.coroutines.Job

// What the Contacts destination shows; changed by MeronMobileState+Contacts.kt.

internal class ContactsScreenState {
    var people by mutableStateOf(emptyList<PersonSummary>())
    var query by mutableStateOf("")
    var loading by mutableStateOf(false)
    var loaded by mutableStateOf(false)

    // The core answered that it has no people commands at all.
    var unavailable by mutableStateOf(false)
    var error by mutableStateOf("")

    // Address books that could not be read, by book (pimSyncErrorsAfter).
    var syncErrors by mutableStateOf(emptyMap<String, String>())
    var selected by mutableStateOf<PersonSummary?>(null)
    var editing by mutableStateOf<ContactEditing?>(null)
    var saving by mutableStateOf(false)
    var confirmingDelete by mutableStateOf<PersonSummary?>(null)

    // The desktop's Contacts → General choices (ADR-0052), read on opening.
    var nameDisplay by mutableStateOf(ContactNameDisplay.AsWritten)
    var nameSort by mutableStateOf(ContactNameSort.Name)
    var searchJob: Job? = null
}
