import { startQuickAction } from '../../states/quickActions'
import { useEffect } from 'react'
import {
  clearBulkSelection,
  selectedBulkItems,
  ui$,
  openCommandPalette,
  closeCommandPalette,
  focusGlobalSearch,
  focusQuickReply,
} from '../../states/ui'
import { settings$, visibleSideNavAccounts } from '../../states/settings'
import { accounts$ } from '../../states/accounts'
import {
  kanban$,
  selectAdjacentKanbanThread,
  selectKanbanBoard,
  closeKanbanBoard,
  openMailAccount,
  closeKanbanPane,
} from '../../states/kanban'
import { openThreadSearch } from '../../states/thread'
import { sidebar$, toggleConversationPanel } from '../../states/sidebar'
import {
  syncMail,
  selectAdjacentThread,
  archiveThread,
  markThreadJunk,
  deleteThread,
  toggleStarWithUndo,
  markUnreadWithUndo,
  bulkArchiveSelected,
  bulkDeleteSelected,
  bulkMarkSelectedUnread,
  bulkStarSelected,
} from '../../states/mail'
import { compose$, openComposeTab, openReplyInFullEditor, closeMessageTab } from '../../states/compose'
import { documentTabOf } from '../chat/activeConversation'
import { handleEditUndoKeyDown } from '../../lib/editUndo'
import { focusInMenu } from '../../lib/menuKeyboard'
import { zoom } from '../../states/zoom'
import { focusAdjacentRegion, modalDialogOpen, trackRegionFocus } from '../../lib/regions'
import {
  isBareShortcut,
  isFunctionKey,
  isMac,
  matchShortcut,
  shortcutChord,
  shortcutForChord,
  RAIL_SHORTCUT_IDS,
  type Chord,
  type RailShortcutId,
  type ShortcutId,
} from '../../lib/shortcuts'

// Whether the conversation pane (and thus its in-thread search) is on screen.
// Only mail draws it: in another module a thread chosen in mail is not shown.
function threadSearchVisible(): boolean {
  if (ui$.module.peek() !== 'mail' || !ui$.selectedThread.peek()) return false
  return !kanban$.activeBoardId.peek() || !!kanban$.paneThreadId.peek()
}

// Is the user currently typing into a field? Bare single-key shortcuts must
// stand down so they don't clobber text entry. A native <select> counts: its
// letter keys pick an option and its arrows step through them (#355).
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

function modalOpen(): boolean {
  return (
    ui$.paletteOpen.peek() ||
    ui$.shortcutsOpen.peek() ||
    ui$.settingsOpen.peek() ||
    ui$.setupOpen.peek() ||
    !!ui$.addFeedAccount.peek() ||
    !!ui$.editFeed.peek() ||
    !!ui$.confirm.peek()
  )
}

// Bare shortcuts are thread-list/conversation actions. They apply in the kanban
// view too — the selected card lives in ui$.selectedThread, same as a chat-list
// row — as long as nothing modal is in the way.
function bareShortcutsActive(): boolean {
  return !modalOpen()
}

function kanbanArrowNavigationActive(): boolean {
  return !!kanban$.activeBoardId.peek() && !modalOpen()
}

function chatArrowNavigationActive(): boolean {
  return !kanban$.activeBoardId.peek() && !modalOpen()
}

// The thread a bare action applies to. On a board the open card wins: an RSS
// card opens in a reader tab without retargeting ui$.selectedThread, which would
// otherwise leave a stale chat-list selection as the target. Same precedence as
// selectAdjacentKanbanThread.
function activeThreadId(): string {
  if (kanban$.activeBoardId.peek()) return kanban$.paneThreadId.peek() || ui$.selectedThread.peek()
  return ui$.selectedThread.peek()
}

// j/k (and the arrow keys) step through whichever list is on screen: the chat
// thread list, or the active board's cards.
function selectAdjacentThreadForView(delta: number) {
  if (kanban$.activeBoardId.peek()) selectAdjacentKanbanThread(delta)
  else selectAdjacentThread(delta)
}

function handleKanbanArrowNavigation(key: string, target: EventTarget | null): boolean {
  if ((key !== 'ArrowDown' && key !== 'ArrowUp') || isTyping(target) || !kanbanArrowNavigationActive()) {
    return false
  }
  selectAdjacentKanbanThread(key === 'ArrowDown' ? 1 : -1)
  return true
}

let threadListDeleteScope = false

function inThreadList(el: Element | null): boolean {
  return !!el?.closest('[data-thread-list]')
}

// The conversation on screen, as a shortcut bound to Delete or Backspace sees
// it (#355). Not the tab strip, a reader or compose tab, nor the quick reply
// composer, whose buttons are not the conversation's.
function inConversation(el: Element | null): boolean {
  return !!el?.closest('[data-conversation]') && !el.closest('[data-quick-reply]')
}

// The thread actions that act on the conversation of mail (#365). Removing
// ones (delete, archive, junk) take it out of view or are hard to undo; star and
// unread change it silently. All act only in the mail module and not under a
// reader or compose tab, whatever their chord: mail's own surfaces (folder pane,
// the docked sidebar's Conversa panel) count, the other modules' do not. Next,
// previous and details change nothing that disappears and stay ungated.
const REMOVING_THREAD_ACTIONS: ReadonlySet<ShortcutId> = new Set(['thread.delete', 'thread.archive', 'thread.junk'])
const MAIL_THREAD_ACTIONS: ReadonlySet<ShortcutId> = new Set([
  ...REMOVING_THREAD_ACTIONS,
  'thread.star',
  'thread.unread',
])

// A reader or compose tab covers the conversation; a thread tab does not, it
// shows its own conversation (the same notion as the message pane's).
function documentTabShowing(): boolean {
  return !!documentTabOf(compose$.tabs.peek(), compose$.activeTab.peek())
}

// The conversation view of mail is the one on screen: mail module, no reader or
// compose tab over it (activeTab "" is the conversation).
function mailConversationShowing(): boolean {
  return ui$.module.peek() === 'mail' && !documentTabShowing()
}

// Where a bare removing key (not Delete or Backspace, which follow #355) acts:
// the list, or under no tab the conversation view or nothing focused (a click on the pane's
// background leaves the body focused). Not the quick reply, a tab or a toolbar.
function removingKeyFocusAllowed(): boolean {
  const el = document.activeElement
  if (ui$.module.peek() !== 'mail') return false
  // The list stays the target under a tab; the rest is the conversation's.
  return inThreadList(el) || (!documentTabShowing() && (inConversation(el) || bodyFocused()))
}

// A list row carries its conversation's id. Opening an RSS row from the Starred
// view shows a reader tab without retargeting ui$.selectedThread, so focus can
// sit on a row that is not the selected conversation: a thread action must not
// fall through to the earlier selection (#369).
function focusedRowIsOtherThread(): boolean {
  // Only while a reader or compose tab covers the conversation: otherwise j/k
  // retarget the selection without moving focus. A bulk selection is the target.
  if (selectedBulkItems().length > 0 || !documentTabShowing()) return false
  const row = document.activeElement?.closest('[data-thread-row]')
  return !!row && row.getAttribute('data-thread-row') !== activeThreadId()
}

/** The keys that delete, whatever shortcut they are bound to. */
function isDeleteKey(key: string): boolean {
  return key === 'Delete' || key === 'Backspace'
}

function bodyFocused(): boolean {
  const el = document.activeElement
  return !el || el === document.body || el === document.documentElement
}

function clearThreadListDeleteScope(event: Event) {
  if (!inThreadList(event.target as Element | null)) threadListDeleteScope = false
}

// Delete is destructive, so unlike the other bare shortcuts it requires focus
// to be inside the thread list of the mail module. A Delete or Backspace bound
// to a shortcut (a scheme, an override) may also act from the conversation
// view (`withConversation`), never from its tabs or quick reply (#355). After
// deleting the focused row, browsers can drop focus to body; keep allowing
// repeated Delete only until the user focuses or clicks outside the list.
function deleteKeyFocusAllowed(withConversation = false): boolean {
  if (ui$.module.peek() !== 'mail') return false
  const el = document.activeElement
  if (inThreadList(el)) {
    threadListDeleteScope = true
    return true
  }
  if (withConversation && inConversation(el)) return true
  return bodyFocused() && threadListDeleteScope
}

// Delete removes the selected thread, same as the context menu action —
// deleteThread itself picks move-to-trash vs permanent based on the folder.
// Active in both the chat and kanban views (selection lives in
// ui$.selectedThread either way), unlike the other bare shortcuts.
function handleDeleteKey(key: string, target: EventTarget | null): boolean {
  if (key !== 'Delete' || isTyping(target) || modalOpen() || !deleteKeyFocusAllowed()) return false
  const threadId = activeThreadId()
  const bulkItems = selectedBulkItems()
  if (bulkItems.length > 0) {
    void bulkDeleteSelected(bulkItems)
    return true
  }
  if (!threadId || focusedRowIsOtherThread()) return false
  void deleteThread(threadId)
  return true
}

// Arrow up/down steps through the chat thread list, just like j/k.
function handleChatArrowNavigation(key: string, target: EventTarget | null): boolean {
  if ((key !== 'ArrowDown' && key !== 'ArrowUp') || isTyping(target) || !chatArrowNavigationActive()) {
    return false
  }
  selectAdjacentThread(key === 'ArrowDown' ? 1 : -1)
  return true
}

function handleRailShortcut(action: ShortcutId): boolean {
  const slot = RAIL_SHORTCUT_IDS.indexOf(action as RailShortcutId)
  // A modal dialog keeps the account or board behind it as it is, whatever
  // key the slot is bound to (an F-key included).
  if (slot === -1 || modalOpen() || modalDialogOpen()) return false

  let target = slot
  if (settings$.showUnifiedInboxInSideNav.peek()) {
    if (target === 0) {
      openMailAccount('unified')
      return true
    }
    target -= 1
  }

  const boards = settings$.kanbanBoards.peek()
  const board = boards[target]
  if (board) {
    selectKanbanBoard(board.id)
    return true
  }
  target -= boards.length

  const account = visibleSideNavAccounts(accounts$.peek())[target]
  if (!account) return false
  openMailAccount(account.id)
  return true
}

// What acts on the first-account setup screen (#343): the shortcuts of the
// app itself, which need no account. The others act on mail or on a module.
const SETUP_SHORTCUTS: ReadonlySet<ShortcutId> = new Set([
  'palette.open',
  'settings.open',
  'shortcuts.help',
  'pane.next',
  'pane.prev',
  'view.zoomIn',
  'view.zoomOut',
  'view.zoomReset',
])

/**
 * Mounts the global keyboard shortcuts. Renders nothing. ⌘/Ctrl-modified
 * shortcuts work everywhere (even while typing); bare single-key shortcuts
 * (j/k/e/s/u/#/i/r) fire in the chat and kanban views when not typing and no
 * modal is open. Per-palette navigation (arrows/enter/esc) lives inside
 * CommandPalette. On the first-account setup screen (`setup`) only the app's
 * own shortcuts act, and the arrows, Escape and Delete stay the page's.
 */
export function AppHotkeys({ setup = false }: { setup?: boolean }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (setup) {
        const action = matchShortcut(event)
        if (!action || !SETUP_SHORTCUTS.has(action)) return
      }

      // Keys typed inside an open menu are the menu's (Delete, Backspace, a
      // letter the menu does not match, #348): a bare shortcut must not act on
      // the conversation behind it. ⌘/Ctrl and Alt chords (⌘/Ctrl+K, which the
      // app menu closes itself for), F-keys and Escape still pass through.
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key !== 'Escape' &&
        !isFunctionKey(event.key) &&
        focusInMenu(event.target instanceof Element ? event.target : null)
      ) {
        return
      }

      if (event.key === 'Escape' && !isTyping(event.target) && !modalOpen() && selectedBulkItems().length > 0) {
        event.preventDefault()
        clearBulkSelection()
        return
      }

      // Esc closes the open kanban conversation pane (it has no thread list to
      // fall back to). Skip while typing or when a modal owns the keystroke;
      // in-thread search handles its own Esc via the input's onKeyDown.
      if (
        event.key === 'Escape' &&
        !isTyping(event.target) &&
        !modalOpen() &&
        kanban$.activeBoardId.peek() &&
        kanban$.paneThreadId.peek()
      ) {
        event.preventDefault()
        closeKanbanPane()
        return
      }

      const action = matchShortcut(event)

      // Undo/redo inside plain text fields, which the Linux webview leaves
      // unbound. Gated on `!action` so a shortcut rebound onto the chord still
      // wins, same precedence as the arrow keys below.
      if (!action && handleEditUndoKeyDown(event)) return

      // Built-in list navigation on the arrow and Delete keys. No default chord
      // uses them, but a user can rebind a shortcut onto one — that binding wins,
      // so the row below never runs behind its back.
      if (
        !action &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        (handleKanbanArrowNavigation(event.key, event.target) ||
          handleChatArrowNavigation(event.key, event.target) ||
          handleDeleteKey(event.key, event.target))
      ) {
        event.preventDefault()
        return
      }

      // Alt+1…9 runs the Quick Action in that place on the selection (#92),
      // through its confirmation: a keystroke never changes mail unseen.
      if (
        !action &&
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        /^Digit[1-9]$/.test(event.code) &&
        !isTyping(event.target) &&
        !modalOpen() &&
        selectedBulkItems().length > 0
      ) {
        const quick = settings$.quickActions.peek()[Number(event.code.slice(5)) - 1]
        if (quick) {
          event.preventDefault()
          startQuickAction(quick, selectedBulkItems())
          return
        }
      }

      if (!action) return

      if (handleRailShortcut(action)) {
        event.preventDefault()
        return
      }

      // While the command palette is open, its own key handler owns navigation
      // and execution. Do not let global chords such as Ctrl+N open composer.
      if (ui$.paletteOpen.peek() && action !== 'palette.open') return

      // Gate single-key shortcuts: never steal a keystroke from a text field,
      // and act only with no modal open. A thread action on Delete or Backspace,
      // chord or not (Ctrl+Backspace deletes a word), is gated like a bare key
      // and acts only where the conversation is the obvious target (#355, #365).
      // A removing thread action on another bare key acts from the list, the
      // conversation view or the body of mail; its chords need only mail.
      const chordKey = shortcutChord(action).key
      const bare = isBareShortcut(action)
      const deleteKey = isDeleteKey(chordKey) && (bare || action.startsWith('thread.'))
      const focusGated = bare || deleteKey
      if (focusGated) {
        if (isTyping(event.target) || !bareShortcutsActive()) return
        if (deleteKey) {
          if (!deleteKeyFocusAllowed(true)) return
        } else if (REMOVING_THREAD_ACTIONS.has(action) && !removingKeyFocusAllowed()) {
          return
        }
      } else if (isFunctionKey(shortcutChord(action).key) && (modalOpen() || modalDialogOpen())) {
        // F1–F12 type nothing, so they work while typing (ADR-0068 §6), but a
        // single key still stands down while a modal dialog is open: it keeps
        // the focus, and F6 does nothing there.
        event.preventDefault()
        return
      }
      if (MAIL_THREAD_ACTIONS.has(action) && focusedRowIsOtherThread()) return
      // The rest (chords, star, unread) need only mail, with no tab over it.
      if (
        !(focusGated && REMOVING_THREAD_ACTIONS.has(action)) &&
        MAIL_THREAD_ACTIONS.has(action) &&
        !mailConversationShowing()
      ) {
        return
      }

      const selected = () => activeThreadId()
      const bulkSelected = () => selectedBulkItems()

      switch (action) {
        case 'palette.open':
          event.preventDefault()
          if (ui$.paletteOpen.peek()) closeCommandPalette()
          else openCommandPalette()
          break
        case 'compose.new':
          event.preventDefault()
          openComposeTab()
          break
        case 'settings.open':
          event.preventDefault()
          ui$.settingsOpen.set(true)
          break
        case 'mail.sync':
          event.preventDefault()
          void syncMail()
          break
        case 'view.toggle': {
          event.preventDefault()
          const activeBoard = kanban$.activeBoardId.peek()
          if (activeBoard) {
            closeKanbanBoard()
          } else {
            const board = settings$.kanbanBoards.peek()[0]
            if (board) selectKanbanBoard(board.id)
          }
          break
        }
        case 'search.thread':
          // Find in the open conversation; fall back to the search in the top
          // band (ADR-0068 §2, #344) when no conversation is on screen.
          // preventDefault stops the webview's native ⌘/Ctrl+F find bar.
          event.preventDefault()
          if (threadSearchVisible()) openThreadSearch()
          else focusGlobalSearch()
          break
        case 'search.global':
          // The band's search, scoped to the module on screen (#344).
          event.preventDefault()
          focusGlobalSearch()
          break
        case 'compose.replyFull':
          // Only meaningful with a conversation on screen; openReplyInFullEditor
          // no-ops otherwise, but gating avoids stealing ⌘/Ctrl+E elsewhere.
          if (!threadSearchVisible()) return
          event.preventDefault()
          openReplyInFullEditor()
          break
        case 'tab.close': {
          // Close the active reader/compose tab. When none is open, let ⌘/Ctrl+W
          // pass through to its default (e.g. closing the window).
          const tab = compose$.activeTab.peek()
          if (!tab) return
          event.preventDefault()
          void closeMessageTab(tab)
          break
        }
        // Work while typing too, as a browser's do: none of these chords
        // edits text, and the editors bind none of them.
        case 'view.zoomIn':
        case 'view.zoomOut':
        case 'view.zoomReset':
          event.preventDefault()
          zoom(action)
          break
        case 'shortcuts.help':
          event.preventDefault()
          ui$.shortcutsOpen.set(!ui$.shortcutsOpen.peek())
          break
        // From region to region (ADR-0068 §6), also from a text field: a
        // function key types nothing. A modal dialog keeps the focus (here
        // too when the shortcut is rebound to a letter, or a ⌘/Ctrl chord).
        case 'pane.next':
        case 'pane.prev':
          event.preventDefault()
          if (modalOpen() || modalDialogOpen()) break
          focusAdjacentRegion(action === 'pane.next' ? 1 : -1)
          break
        case 'thread.next':
          event.preventDefault()
          selectAdjacentThreadForView(1)
          break
        case 'thread.prev':
          event.preventDefault()
          selectAdjacentThreadForView(-1)
          break
        case 'thread.archive':
          if (bulkSelected().length > 0) {
            event.preventDefault()
            void bulkArchiveSelected(bulkSelected())
            break
          }
          if (!selected()) return
          event.preventDefault()
          void archiveThread(selected())
          break
        case 'thread.star':
          if (bulkSelected().length > 0) {
            event.preventDefault()
            void bulkStarSelected(bulkSelected(), true)
            break
          }
          if (!selected()) return
          event.preventDefault()
          toggleStarWithUndo(selected())
          break
        case 'thread.unread':
          if (bulkSelected().length > 0) {
            event.preventDefault()
            void bulkMarkSelectedUnread(bulkSelected())
            break
          }
          if (!selected()) return
          event.preventDefault()
          markUnreadWithUndo(selected())
          break
        case 'thread.delete':
          if (bulkSelected().length > 0) {
            event.preventDefault()
            void bulkDeleteSelected(bulkSelected())
            break
          }
          if (!selected()) return
          event.preventDefault()
          void deleteThread(selected())
          break
        case 'thread.details':
          // The app sidebar's Conversa panel (ADR-0069 §2): expanded on it,
          // minimised (or, as an overlay, closed); otherwise expanded on it.
          // Only while it is there: a conversation on screen, not under a
          // reader or compose tab, nor below 769 px with the list in its place.
          if (!sidebar$.conversationOpen.peek()) return
          event.preventDefault()
          toggleConversationPanel()
          break
        case 'thread.junk':
          if (!selected()) return
          event.preventDefault()
          void markThreadJunk(selected(), true)
          break
        case 'reply.focus':
          if (!threadSearchVisible()) return
          event.preventDefault()
          focusQuickReply()
          break
      }
    }

    // Keys forwarded out of an HTML message iframe, which the global keydown
    // listener never sees: ⌘/Ctrl (or Alt) chords such as ⌘/Ctrl+F, plus bare
    // ArrowUp/ArrowDown. The detail is the chord HtmlFrame reconstructed.
    const onFrameKeyDown = (event: Event) => {
      const chord = (event as CustomEvent<Chord | undefined>).detail
      if (!chord?.key) return

      // A shortcut rebound onto the arrow key wins over list navigation, same
      // precedence as in the main handler. Replaying it as a real keydown runs
      // it through the one switch above instead of duplicating the dispatch.
      if (shortcutForChord(chord)) {
        // Cancelable so the switch above can report back whether it acted: a
        // bound chord it declines (⌘/Ctrl+W with no tab open) must keep its
        // native behaviour inside the frame rather than being swallowed here.
        const replay = new KeyboardEvent('keydown', {
          key: chord.key,
          cancelable: true,
          ctrlKey: !!chord.mod && !isMac,
          metaKey: !!chord.mod && isMac,
          shiftKey: !!chord.shift,
          altKey: !!chord.alt,
        })
        if (!window.dispatchEvent(replay)) event.preventDefault()
        return
      }

      if (!chord.mod && !chord.alt && !chord.shift && handleKanbanArrowNavigation(chord.key, null)) {
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('focusin', clearThreadListDeleteScope)
    window.addEventListener('pointerdown', clearThreadListDeleteScope)
    window.addEventListener('oreneta.frameKeyDown', onFrameKeyDown)
    const stopTrackingRegionFocus = trackRegionFocus()
    return () => {
      stopTrackingRegionFocus()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('focusin', clearThreadListDeleteScope)
      window.removeEventListener('pointerdown', clearThreadListDeleteScope)
      window.removeEventListener('oreneta.frameKeyDown', onFrameKeyDown)
    }
  }, [setup])

  return null
}
