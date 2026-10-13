package jp.nonbili.meron.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.nonbili.meron.shared.PersonDraft
import jp.nonbili.meron.shared.PersonEmail
import jp.nonbili.meron.shared.PersonPhone
import jp.nonbili.meron.shared.PersonSummary

// The Contacts destination's screens: the searchable list, a person's card,
// and the editor for the books this app may write to. State lives in
// ContactsScreenState and every action goes through the callbacks, which
// MeronMobileState+Contacts.kt provides (see PimRoutesUi.kt).

internal class ContactsActions(
    val onOpenDrawer: () -> Unit,
    val onQueryChange: (String) -> Unit,
    val onRefresh: () -> Unit,
    val onNewContact: () -> Unit,
    val onEditContact: (PersonSummary) -> Unit,
    val onSaveContact: () -> Unit,
    val onKeepMine: () -> Unit,
    val onKeepSaved: () -> Unit,
    val onDeleteContact: (PersonSummary) -> Unit,
    val onWriteTo: (String) -> Unit,
    val onCopy: (String) -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ContactsScreen(
    ui: ContactsScreenState,
    drawerState: DrawerState,
    drawerContent: @Composable () -> Unit,
    actions: ContactsActions,
) {
    ModalNavigationDrawer(drawerState = drawerState, drawerContent = drawerContent) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(tr("people.title")) },
                    navigationIcon = {
                        IconButton(onClick = actions.onOpenDrawer) {
                            Icon(Icons.Filled.Menu, contentDescription = tr("mobile.actions.openNavigation"))
                        }
                    },
                    actions = {
                        IconButton(onClick = actions.onRefresh) {
                            Icon(Icons.Filled.Refresh, contentDescription = tr("mobile.actions.refresh"))
                        }
                    },
                )
            },
            floatingActionButton = {
                if (!ui.unavailable) {
                    ExtendedFloatingActionButton(
                        onClick = actions.onNewContact,
                        icon = { Icon(Icons.Filled.PersonAdd, contentDescription = null) },
                        text = { Text(tr("people.newContact")) },
                    )
                }
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                if (ui.unavailable) {
                    EmptyState(Icons.Filled.Contacts, tr("people.title"), tr("mobile.contacts.unavailable"))
                    return@Column
                }
                if (ui.error.isNotBlank()) {
                    StatusBanner(
                        message = ui.error,
                        isError = true,
                        actionLabel = tr("buttons.retry"),
                        onAction = actions.onRefresh,
                        onDismiss = { ui.error = "" },
                    )
                }
                // Background reads that failed: said, without hiding what
                // the phone still has.
                pimSyncBanner(ui.syncErrors, CONTACTS_SCOPE_MISSING_KEY, CONTACTS_SYNC_FAILED_KEY)?.let { (key, args) ->
                    StatusBanner(
                        message = tr(key, args),
                        isError = false,
                        actionLabel = null,
                        onAction = null,
                        onDismiss = { ui.syncErrors = emptyMap() },
                    )
                }
                OutlinedTextField(
                    value = ui.query,
                    onValueChange = actions.onQueryChange,
                    placeholder = { Text(tr("people.search")) },
                    leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                    trailingIcon = {
                        if (ui.query.isNotEmpty()) {
                            IconButton(onClick = { actions.onQueryChange("") }) {
                                Icon(Icons.Filled.Close, contentDescription = tr("common.clearSearch"))
                            }
                        }
                    },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                )
                val people = remember(ui.people, ui.nameSort) { sortedForList(collapseLinked(ui.people), ui.nameSort) }
                when {
                    !ui.loaded && ui.loading -> {
                        LoadingState(tr("people.loading"))
                    }

                    people.isEmpty() && ui.query.isNotBlank() -> {
                        EmptyState(Icons.Filled.Search, tr("people.noMatch"), tr("people.tryAnother"))
                    }

                    people.isEmpty() && ui.loaded -> {
                        EmptyState(Icons.Filled.Contacts, tr("people.emptyTitle"), tr("people.emptyText"))
                    }

                    else -> {
                        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                            items(people, key = { it.id }) { person ->
                                PersonRow(person, ui.nameDisplay, onClick = { ui.selected = person })
                            }
                        }
                    }
                }
            }
        }
    }

    ui.selected?.let { person ->
        PersonCardDialog(
            person = person,
            display = ui.nameDisplay,
            onDismiss = { ui.selected = null },
            onEdit = { actions.onEditContact(person) },
            onDelete = { ui.confirmingDelete = person },
            onWriteTo = actions.onWriteTo,
            onCopy = actions.onCopy,
        )
    }
    ui.editing?.let { editing ->
        if (editing.conflict != null) {
            ContactConflictDialog(editing, ui.saving, actions)
        } else {
            ContactEditorDialog(
                editing = editing,
                saving = ui.saving,
                onChange = { ui.editing = editing.copy(draft = it) },
                onSave = actions.onSaveContact,
                onDismiss = {
                    if (!ui.saving) ui.editing = null
                },
            )
        }
    }
    ui.confirmingDelete?.let { person ->
        AlertDialog(
            onDismissRequest = { ui.confirmingDelete = null },
            title = { Text(tr("people.deleteTitle")) },
            text = { Text(person.displayLabel(ui.nameDisplay)) },
            confirmButton = {
                TextButton(onClick = { actions.onDeleteContact(person) }) {
                    Text(tr("buttons.delete"), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { ui.confirmingDelete = null }) { Text(tr("buttons.cancel")) } },
        )
    }
}

@Composable
private fun PersonRow(
    person: PersonSummary,
    display: ContactNameDisplay,
    onClick: () -> Unit,
) {
    val label = person.displayLabel(display)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AccountBadgeAvatar(label = label, avatarUrl = "", size = 40.dp)
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val secondary =
                listOfNotNull(
                    person.emails
                        .firstOrNull()
                        ?.addr
                        ?.takeIf { it != label },
                    person.organisation.takeIf { it.isNotBlank() },
                )
            if (secondary.isNotEmpty()) {
                Text(
                    secondary.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun PersonCardDialog(
    person: PersonSummary,
    display: ContactNameDisplay,
    onDismiss: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onWriteTo: (String) -> Unit,
    onCopy: (String) -> Unit,
) {
    val editable = person.editableOnMobile()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(person.displayLabel(display)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (person.organisation.isNotBlank()) Text(person.organisation, style = MaterialTheme.typography.bodyMedium)
                Text(tr(person.sourceKey()), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (person.emails.isNotEmpty()) {
                    CardLabel(tr("people.emails"))
                    for (email in person.emails) {
                        CardLine(
                            value = email.addr,
                            label = email.label,
                            onCopy = { onCopy(email.addr) },
                            primaryIcon = {
                                IconButton(onClick = { onWriteTo(email.addr) }) {
                                    Icon(
                                        Icons.AutoMirrored.Filled.Send,
                                        contentDescription = tr("people.writeTo", mapOf("addr" to email.addr)),
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            },
                            onClick = { onWriteTo(email.addr) },
                        )
                    }
                }
                if (person.phones.isNotEmpty()) {
                    CardLabel(tr("people.phones"))
                    for (phone in person.phones) {
                        CardLine(value = phone.number, label = phone.label, onCopy = { onCopy(phone.number) })
                    }
                }
                if (person.note.isNotBlank()) {
                    CardLabel(tr("people.note"))
                    Text(person.note, style = MaterialTheme.typography.bodyMedium)
                }
                if (!editable) {
                    Text(tr("mobile.contacts.readOnly"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        confirmButton = {
            Row {
                if (editable) {
                    TextButton(onClick = onDelete) { Text(tr("buttons.delete"), color = MaterialTheme.colorScheme.error) }
                    TextButton(onClick = onEdit) { Text(tr("people.edit")) }
                }
                TextButton(onClick = onDismiss) { Text(tr("buttons.close")) }
            }
        },
    )
}

@Composable
private fun CardLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun CardLine(
    value: String,
    label: String,
    onCopy: () -> Unit,
    primaryIcon: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(
            Modifier.weight(1f).let { if (onClick != null) it.clickable(onClick = onClick) else it },
        ) {
            Text(value, style = MaterialTheme.typography.bodyMedium, color = if (onClick != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            if (label.isNotBlank()) Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        primaryIcon?.invoke()
        IconButton(onClick = onCopy) {
            Icon(Icons.Filled.ContentCopy, contentDescription = tr("people.copy"), modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun ContactEditorDialog(
    editing: ContactEditing,
    saving: Boolean,
    onChange: (PersonDraft) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    val draft = editing.draft
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (editing.isNew) tr("people.newTitle") else tr("people.editTitle")) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = draft.name,
                    onValueChange = { onChange(draft.copy(name = it)) },
                    label = { Text(tr("people.name")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = draft.organisation,
                    onValueChange = { onChange(draft.copy(organisation = it)) },
                    label = { Text(tr("people.organisationField")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                draft.emails.forEachIndexed { index, email ->
                    EditableRow(
                        value = email.addr,
                        label = tr("people.emailN", mapOf("n" to index + 1)),
                        removeLabel = tr("people.removeEmail"),
                        onValueChange = { value -> onChange(draft.copy(emails = draft.emails.replaced(index, email.copy(addr = value)))) },
                        onRemove = { onChange(draft.copy(emails = draft.emails.filterIndexed { i, _ -> i != index })) },
                    )
                }
                TextButton(onClick = { onChange(draft.copy(emails = draft.emails + PersonEmail(""))) }) { Text(tr("people.addEmail")) }
                draft.phones.forEachIndexed { index, phone ->
                    EditableRow(
                        value = phone.number,
                        label = tr("people.phoneN", mapOf("n" to index + 1)),
                        removeLabel = tr("people.removePhone"),
                        onValueChange = { value -> onChange(draft.copy(phones = draft.phones.replaced(index, phone.copy(number = value)))) },
                        onRemove = { onChange(draft.copy(phones = draft.phones.filterIndexed { i, _ -> i != index })) },
                    )
                }
                TextButton(onClick = { onChange(draft.copy(phones = draft.phones + PersonPhone(""))) }) { Text(tr("people.addPhone")) }
                OutlinedTextField(
                    value = draft.note,
                    onValueChange = { onChange(draft.copy(note = it)) },
                    label = { Text(tr("people.note")) },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                // New people go to the book on this device, which nothing else has a copy of.
                if (editing.isNew) {
                    Text(tr("people.source.local"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onSave, enabled = !saving && draft.hasContent()) {
                if (saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(tr("buttons.save"))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text(tr("buttons.cancel")) } },
    )
}

@Composable
private fun EditableRow(
    value: String,
    label: String,
    removeLabel: String,
    onValueChange: (String) -> Unit,
    onRemove: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            label = { Text(label) },
            singleLine = true,
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onRemove) { Icon(Icons.Filled.Close, contentDescription = removeLabel) }
    }
}

/** Saving found the person changed or deleted elsewhere; nothing was saved. */
@Composable
private fun ContactConflictDialog(
    editing: ContactEditing,
    saving: Boolean,
    actions: ContactsActions,
) {
    val current = editing.conflict?.current
    AlertDialog(
        onDismissRequest = actions.onKeepSaved,
        title = { Text(tr("people.conflictTitle")) },
        text = { Text(if (current == null) tr("people.deletedText") else tr("people.conflictText")) },
        confirmButton = {
            TextButton(onClick = actions.onKeepMine, enabled = !saving) {
                Text(if (current == null) tr("people.createAgain") else tr("people.keepMine"))
            }
        },
        dismissButton = {
            TextButton(onClick = actions.onKeepSaved, enabled = !saving) {
                Text(if (current == null) tr("people.discardMine") else tr("people.keepSaved"))
            }
        },
    )
}

private fun <T> List<T>.replaced(
    index: Int,
    value: T,
): List<T> = mapIndexed { i, item -> if (i == index) value else item }
