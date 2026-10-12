package jp.nonbili.meron.ui

import androidx.compose.material3.DrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import jp.nonbili.meron.shared.FolderSummary
import kotlinx.coroutines.launch

// The Calendar and Contacts routes: their screens wired to the state's
// actions, under the same navigation drawer as Mail and Kanban.

@Composable
internal fun CalendarRouteContent(
    state: MeronMobileState,
    drawerState: DrawerState,
    drawerFolders: List<FolderSummary>,
) {
    with(state) {
        LaunchedEffect(Unit) {
            // Reached by back navigation or a restored route rather than the drawer.
            if (calendarUi.window == null) loadCalendarScreen(refresh = true)
        }
        CalendarScreen(
            ui = calendarUi,
            drawerState = drawerState,
            drawerContent = { DestinationDrawer(state, drawerState, drawerFolders) },
            actions =
                CalendarActions(
                    onOpenDrawer = { scope.launch { drawerState.open() } },
                    onToday = ::showCalendarToday,
                    onMoveWindow = ::moveCalendarWindow,
                    onRefresh = { loadCalendarScreen(refresh = true) },
                    onSetCalendarShown = ::setCalendarShown,
                    onNewEvent = ::startNewCalendarEvent,
                    onOpenEvent = ::openCalendarEvent,
                    onCloseEvent = ::closeCalendarEvent,
                    editBlock = ::calendarEditBlock,
                    onEditEvent = ::startEditingCalendarEvent,
                    onSaveDraft = ::saveCalendarDraft,
                    onDeleteEvent = ::deleteCalendarEvent,
                    onOpenUrl = services::openUrl,
                ),
        )
    }
}

@Composable
internal fun ContactsRouteContent(
    state: MeronMobileState,
    drawerState: DrawerState,
    drawerFolders: List<FolderSummary>,
) {
    with(state) {
        LaunchedEffect(Unit) {
            if (!contactsUi.loaded) loadPeople()
        }
        ContactsScreen(
            ui = contactsUi,
            drawerState = drawerState,
            drawerContent = { DestinationDrawer(state, drawerState, drawerFolders) },
            actions =
                ContactsActions(
                    onOpenDrawer = { scope.launch { drawerState.open() } },
                    onQueryChange = ::changeContactsQuery,
                    onRefresh = { loadPeople() },
                    onNewContact = ::startNewContact,
                    onEditContact = ::startEditingContact,
                    onSaveContact = { saveContact() },
                    onKeepMine = ::keepMyContact,
                    onKeepSaved = ::keepSavedContact,
                    onDeleteContact = ::deleteContact,
                    onWriteTo = { address ->
                        contactsUi.selected = null
                        composeToContact(address)
                    },
                    onCopy = { value -> services.copyText(value, value) },
                ),
        )
    }
}

/** The navigation drawer as these destinations show it: leaving them goes to Mail or Kanban. */
@Composable
private fun DestinationDrawer(
    state: MeronMobileState,
    drawerState: DrawerState,
    drawerFolders: List<FolderSummary>,
) {
    with(state) {
        MailDrawer(
            accounts = coreAccounts.filterNot { it.id in hiddenNavigationAccountIds },
            selectedAccountId = selectedCoreAccountId,
            folders = drawerFolders,
            currentScreen = screen,
            showUnreadBadges = showUnreadBadges,
            showUnifiedInboxNav = showUnifiedInboxNav,
            kanbanBoards = kanbanBoards,
            activeKanbanBoardId = activeKanbanBoardId,
            onSelectUnified = {
                if (selectedCoreAccountId != UNIFIED_ACCOUNT_ID) {
                    selectCoreMailbox(UNIFIED_ACCOUNT_ID, INBOX_FOLDER)
                    syncCoreThreads(accountOverride = UNIFIED_ACCOUNT_ID, folderOverride = INBOX_FOLDER, syncFirst = false)
                }
                previousTopScreen = Screen.Mail
                screen = Screen.Mail
                scope.launch { drawerState.close() }
            },
            onSelectAccount = { account ->
                if (selectedCoreAccountId != account.id) {
                    selectCoreMailbox(account.id, INBOX_FOLDER)
                    syncCoreThreads(accountOverride = account.id, folderOverride = INBOX_FOLDER, syncFirst = false)
                }
                previousTopScreen = Screen.Mail
                screen = Screen.Mail
                scope.launch { drawerState.close() }
            },
            onSelectKanban = {
                screen = Screen.Kanban
                previousTopScreen = Screen.Kanban
                loadKanbanBoard(refresh = false)
                scope.launch { drawerState.close() }
            },
            onSelectKanbanBoard = { board ->
                activeKanbanBoardId = board.id
                saveActiveKanbanBoardId(kanbanPrefs, board.id)
                screen = Screen.Kanban
                previousTopScreen = Screen.Kanban
                loadKanbanBoard(refresh = false)
                scope.launch { drawerState.close() }
            },
            onAddAccount = {
                resetPasswordAccountForm()
                addSection = 0
                previousTopScreen = screen
                screen = Screen.AddAccount
                scope.launch { drawerState.close() }
            },
            onOpenSettings = {
                previousTopScreen = screen
                screen = Screen.Settings
                scope.launch { drawerState.close() }
            },
            onShowAbout = {
                showAboutDialog = true
                scope.launch { drawerState.close() }
            },
            googleReauthAccountId = googleReauthAccountId,
            onReconnectGoogle = {
                connectGoogleDeviceAccount()
                scope.launch { drawerState.close() }
            },
            onSelectCalendar = {
                openCalendarScreen()
                scope.launch { drawerState.close() }
            },
            onSelectContacts = {
                openContactsScreen()
                scope.launch { drawerState.close() }
            },
        )
    }
}
