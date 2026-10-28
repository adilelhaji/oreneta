import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'
import {
  Archive,
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Code,
  Copy,
  FileText,
  Mail,
  MailOpen,
  MoreVertical,
  PanelRight,
  Search,
  SquarePen,
  Star,
  Tag,
  Trash2,
  X,
  Printer,
  Sparkles,
} from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { assistantEnabled$ } from '../../states/assistant'
import { settings$ } from '../../states/settings'
import { BASE_ROOT_FONT_SIZE, clampFontScale } from '../../lib/fonts'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { showToast, ui$ } from '../../states/ui'
import {
  archiveThread,
  deleteThread,
  isDraftFolder,
  isJunkFolderId,
  mail$,
  markThreadJunk,
  markThreadRead,
  markThreadUnread,
  starThread,
} from '../../states/mail'
import { printFromReader } from '../../states/printing'
import { LabelMenuItems, LabelPicker, useLabelToggle } from './LabelPicker'
import { thread$, type ConversationMode } from '../../states/thread'
import { closeKanbanPane, kanban$, openCorrespondentMail } from '../../states/kanban'
import { toggleConversationPanel } from '../../states/sidebar'
import { useConversationPanelExpanded } from '../shell/useSidebarShown'
import { openComposeTab } from '../../states/compose'
import type { Message } from '../../types'
import { Avatar } from '../avatar/Avatar'
import { IconButton } from '../button/IconButton'
import { FloatingContextMenu } from '../menu/FloatingContextMenu'
import { MenuItem } from '../menu/MenuItem'
import { MenuList, MenuSeparator } from '../menu/Menu'
import { menuItemCurrentClass } from '../menu/menuStyles'
import { SubmenuItem } from '../menu/SubmenuItem'
import { targetWithin } from '../menu/useDismissOnOutside'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { ConversationSubject } from './ConversationSubject'
import { ReadingHeaderSummary } from './ReadingHeaderSummary'
import { isConversation, summariseThread } from './readingHeader'
import { accountIdentities, accounts$ } from '../../states/accounts'
import { messageChangesBlocked, readOnlyTarget, sendBlocked } from '../../lib/mailCapabilities'
import { AssistantReviewDialog } from './AssistantReviewDialog'

/** Marks the «Label» submenu, drawn outside the header, as part of «More actions». */
const ACTIONS_MENU_ATTRIBUTE = 'data-conversation-actions'

/** Kept between «More actions» and the bottom edge it may not pass, in px. */
const ACTIONS_MENU_MARGIN = 8

/**
 * The height left to `element` from its top down to the first edge that cuts
 * it: the window's, or that of an ancestor clipping what overflows it (the
 * reader does), in CSS px and whole pixels (#347).
 */
function roomBelow(element: HTMLElement, margin: number): number {
  const clips = (overflow: string) => ['hidden', 'clip', 'auto', 'scroll'].includes(overflow)
  let bottom = window.innerHeight
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (clips(style.overflowX) || clips(style.overflowY)) bottom = Math.min(bottom, node.getBoundingClientRect().bottom)
  }
  // Boxes are visual pixels; a style's are CSS pixels under a root zoom.
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1
  return Math.max(0, Math.floor((bottom - element.getBoundingClientRect().top - margin) / zoom))
}

// The conversation header: back/close affordances, sender info, the desktop
// in-thread search box and the overflow actions menu (view mode, star, archive,
// delete). Search match state is computed by the parent via useThreadSearch.
export function ConversationHeader({
  activeThread,
  isRSS,
  conversationMode,
  setQuickConversationMode,
  searchMatches,
  activeSearchIndex,
  goToSearchMatch,
  desktopSearchInputRef,
}: {
  activeThread: Message
  isRSS: boolean
  conversationMode: ConversationMode
  setQuickConversationMode: (mode: ConversationMode) => void
  searchMatches: string[]
  activeSearchIndex: number
  goToSearchMatch: (direction: -1 | 1) => void
  desktopSearchInputRef: RefObject<HTMLInputElement | null>
}) {
  const { t } = useTranslation()
  const inKanban = !!useValue(kanban$.activeBoardId)
  const threadSearch = useValue(thread$.search)
  const threadSearchOpen = useValue(thread$.searchOpen)
  // The app sidebar's Conversa panel (ADR-0069): these buttons do what `i` does.
  const detailsOpen = useConversationPanelExpanded()
  const normalizedThreadSearch = threadSearch.trim().toLowerCase()

  // The conversation as a whole, for the line under the subject. Derived from
  // the messages actually loaded plus the thread's own counts, so it stays
  // honest about a long thread whose older half is still on the server.
  const loadedMessages = useValue(mail$.messages)
  const messagesCursor = useValue(mail$.messagesCursor)
  const accounts = useValue(accounts$)
  const readOnly = readOnlyTarget(accounts, activeThread.account_id)
  // Star, read state, archive and trash change messages: on Graph they need
  // the change permission (#141). Writing to the sender is sending.
  const changesBlocked = messageChangesBlocked(accounts, activeThread.account_id)
  const sendingBlocked = sendBlocked(accounts, activeThread.account_id)
  // Read so the junk button below follows the folder lists as they load: in
  // the junk folder the useful gesture is the opposite one (#245). A draft is
  // never junk, as in the selection bar.
  useValue(mail$.foldersByAccount)
  useValue(mail$.folders)
  const inJunk = isJunkFolderId(activeThread.account_id, activeThread.folder_id)
  const offersJunk = !isRSS && !isDraftFolder(activeThread.folder_id, activeThread.account_id)
  const junkLabel = inJunk ? t('threads.actions.markNotJunk') : t('threads.actions.markJunk')
  const toggleJunk = () => void markThreadJunk(activeThread.thread_id, !inJunk)
  const ownAddresses = accounts
    .filter((account) => account.id === activeThread.account_id)
    .flatMap((account) => accountIdentities(account).map((identity) => identity.email))
  const summary = summariseThread(activeThread, loadedMessages, !!messagesCursor, ownAddresses)
  // One array per change of the loaded messages, not per render: the
  // assistant review keys its selection and preview on what it is given (#196).
  const threadMessages = useMemo(
    () => loadedMessages.filter((message) => message.thread_id === activeThread.thread_id),
    [loadedMessages, activeThread.thread_id],
  )

  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  // Off until turned on in Settings (#51).
  const assistantEnabled = useValue(assistantEnabled$)
  // The «Label» submenu is 14 rem wide, like the picker's own menu; its side
  // is chosen from that width in px, at the app's size (#347).
  const fontScale = useValue(settings$.fontScale)
  const labelMenuWidth = (14 * BASE_ROOT_FONT_SIZE * clampFontScale(fontScale)) / 100
  const labelToggle = useLabelToggle(activeThread.thread_id, activeThread.labels ?? [])
  const [senderMenu, setSenderMenu] = useState<{ x: number; y: number } | null>(null)
  const actionsMenuRef = useRef<HTMLDivElement | null>(null)

  // «More actions» is no taller than the room under it: the reader clips
  // what overflows it, and at the app's 200 % in a short window its last rows
  // (details, «Label») were cut off while the arrow keys still reached them.
  // It scrolls instead, and is a Tab stop as a scrolling region (#347).
  const [actionsMenuMaxHeight, setActionsMenuMaxHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!actionsMenuOpen) {
      setActionsMenuMaxHeight(null)
      return
    }
    const menu = actionsMenuRef.current?.querySelector<HTMLElement>('[role="menu"]')
    if (!menu) return
    const fit = () => setActionsMenuMaxHeight(roomBelow(menu, ACTIONS_MENU_MARGIN))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [actionsMenuOpen])

  useEffect(() => {
    if (!actionsMenuOpen) return
    const onDown = (event: MouseEvent) => {
      // The «Label» submenu (#347) is drawn in a layer of its own, outside
      // the header, but it is part of this menu.
      if (targetWithin(event.target, `[${ACTIONS_MENU_ATTRIBUTE}]`)) return
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(event.target as Node)) {
        setActionsMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [actionsMenuOpen])
  // Escape closes the menu (#289); a click outside still does, as before.
  useEscapeKey(() => setActionsMenuOpen(false), actionsMenuOpen)

  useEffect(() => {
    setSenderMenu(null)
  }, [activeThread.thread_id])

  const copyHeaderText = (text: string, toast: string) => {
    const value = text.trim()
    if (!value) return
    const write = navigator.clipboard?.writeText(value)
    if (!write) return
    write
      .then(() => {
        showToast(toast)
      })
      .catch(() => undefined)
  }

  const senderName = activeThread.from_name.trim()
  const senderEmail = activeThread.from_addr.trim()
  const senderDisplayName = senderName || senderEmail
  const senderRecipient = senderName && senderName !== senderEmail ? `${senderName} <${senderEmail}>` : senderEmail

  const openSenderMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault()
    setSenderMenu({ x: event.clientX, y: event.clientY })
  }

  return (
    <>
      <header className="@container relative z-40 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-header px-2 select-none">
        <button
          className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-hover text-secondary min-[769px]:hidden cursor-pointer"
          onClick={() => ui$.mobilePane.set('threads')}
          title={t('chat.backToChats')}
        >
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>

        {inKanban && (
          <button
            className="-me-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-hover text-secondary cursor-pointer max-[600px]:hidden"
            onClick={closeKanbanPane}
            title={t('chat.closeConversationEsc')}
          >
            <X size={20} strokeWidth={1.75} />
          </button>
        )}

        <Avatar
          name={activeThread.from_name || activeThread.from_addr}
          email={isRSS ? undefined : activeThread.from_addr}
          src={isRSS && activeThread.feed_icon ? `/media/${activeThread.feed_icon}` : undefined}
        />

        <div className="min-w-0 flex-1">
          <ConversationSubject
            subject={activeThread.subject}
            copyLabel={t('chat.copySubject')}
            onCopy={() => copyHeaderText(activeThread.subject, 'Subject copied')}
          />
          {isRSS ? (
            // RSS subject == from_name (both the feed title), so showing the name
            // again would just duplicate the title above. Show the feed host only.
            <p className="truncate text-xs text-secondary mt-0.5 font-medium" title={activeThread.from_addr}>
              {activeThread.from_addr}
            </p>
          ) : isConversation(summary) ? (
            <ReadingHeaderSummary
              summary={summary}
              onSenderMenu={openSenderMenu}
              detailsOpen={detailsOpen}
              onOpenDetails={toggleConversationPanel}
            />
          ) : (
            <button
              type="button"
              onClick={openSenderMenu}
              onContextMenu={openSenderMenu}
              className="mt-0.5 block max-w-full truncate rounded-sm text-start text-xs font-medium text-secondary outline-none transition-colors cursor-context-menu hover:text-accent-fg focus-visible:ring-2 focus-visible:ring-accent/40"
              title={`${activeThread.from_name} (${activeThread.from_addr})`}
              aria-label={t('chat.copyFullAddress')}
            >
              {senderName ? (
                <>
                  {senderName} <span className="font-normal">({senderEmail})</span>
                </>
              ) : (
                senderEmail
              )}
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Every button but «Archive thread» and «More actions» gives way in a
              narrow header, measured on the header itself in rem, so a larger
              app size (#181) makes room the same way a narrower window does;
              those two never do (ADR-0068 §3). Not everything that gives way
              is in «More actions»: it always has star and, for mail, archive,
              junk (where offered) and trash, and it has search, label and
              details while their buttons are hidden; mark read or unread and
              «Review with assistant» are not in it. At the app's 200 % in a
              1025 px window the reader is 360 px, 11.25 rem: the two and the
              subject (#347). */}
          {!threadSearchOpen ? (
            <IconButton
              icon={Search}
              label={t('chat.searchThread')}
              className="hidden @min-[16rem]:flex"
              onClick={() => thread$.searchOpen.set(true)}
            />
          ) : (
            // In the header only where it fits beside the subject, «Archive
            // thread», details and «More actions»: from 900 px and a header
            // of 32 rem. Otherwise the bar under the header has the search
            // (ThreadSearchBarMobile, on the same two conditions). In rem, so
            // the app's size (#181) moves the threshold with it; 17.875 rem
            // is the 286 px it was at 100 % (#347).
            <div className="hidden min-[900px]:@min-[32rem]:flex w-[17.875rem] items-center gap-1 rounded-control bg-hover px-2 py-1.5 border border-transparent focus-within:border-accent/40 focus-within:bg-chats">
              <Search size={14} className="text-secondary shrink-0" strokeWidth={1.75} />
              <input
                ref={desktopSearchInputRef}
                value={threadSearch}
                onChange={(event) => thread$.search.set(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    goToSearchMatch(event.shiftKey ? -1 : 1)
                  }
                  if (event.key === 'Escape') {
                    thread$.search.set('')
                    thread$.searchOpen.set(false)
                  }
                }}
                placeholder={t('chat.searchThread')}
                className="min-w-0 flex-1 bg-transparent text-xs text-primary placeholder-secondary border-none outline-none"
              />
              <button
                onClick={() => {
                  thread$.search.set('')
                  thread$.searchOpen.set(false)
                }}
                className="flex h-5 w-5 items-center justify-center rounded-full text-secondary hover:text-primary cursor-pointer"
                title={t('chat.closeThreadSearch')}
              >
                <X size={14} strokeWidth={1.75} />
              </button>
              <span className="w-10 text-center text-2xs font-semibold text-secondary">
                {normalizedThreadSearch
                  ? `${searchMatches.length ? activeSearchIndex + 1 : 0}/${searchMatches.length}`
                  : ''}
              </span>
              <button
                onClick={() => goToSearchMatch(-1)}
                disabled={searchMatches.length === 0}
                className="flex h-6 w-6 items-center justify-center rounded-control-sm text-secondary hover:bg-active disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                title={t('chat.previousMatch')}
              >
                <ChevronUp size={14} strokeWidth={1.75} />
              </button>
              <button
                onClick={() => goToSearchMatch(1)}
                disabled={searchMatches.length === 0}
                className="flex h-6 w-6 items-center justify-center rounded-control-sm text-secondary hover:bg-active disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                title={t('chat.nextMatch')}
              >
                <ChevronDown size={14} strokeWidth={1.75} />
              </button>
            </div>
          )}
          {/* The actions a reader reaches for constantly, as buttons rather
              than as three lines inside a menu. Archiving a conversation
              should not cost two clicks and a read of five other options.
              They step aside while the thread search is open, which needs the
              width more than they do; «Archive thread» does not, like «More
              actions» (ADR-0068 §3, #347). */}
          {!threadSearchOpen && (
            <>
              {/* Gives way first, below 42 rem; not in the menu. */}
              {assistantEnabled && (
                <IconButton
                  icon={Sparkles}
                  label={t('assistant.open', { defaultValue: 'Review with assistant' })}
                  onClick={() => setAssistantOpen(true)}
                  className="hidden @min-[42rem]:flex"
                />
              )}
              {/* Below 24 rem, star and read state give way. Star stays in
                  the menu below; read state is not in it. Measured on the
                  header itself, in rem, so a larger app size (#181) makes
                  room the same way a narrower window does. */}
              <IconButton
                icon={Star}
                disabled={changesBlocked}
                label={activeThread.starred ? t('chat.unstar') : t('chat.star')}
                className={clsx('hidden @min-[24rem]:flex', activeThread.starred && 'text-warning')}
                onClick={() => void starThread(activeThread.thread_id, !activeThread.starred)}
              />
              <IconButton
                icon={activeThread.unread ? MailOpen : Mail}
                disabled={changesBlocked}
                label={activeThread.unread ? t('threads.actions.markAsRead') : t('threads.actions.markAsUnread')}
                className="hidden @min-[24rem]:flex"
                onClick={() =>
                  void (activeThread.unread
                    ? markThreadRead(activeThread.thread_id)
                    : markThreadUnread(activeThread.thread_id))
                }
              />
              {/* Next to give way, below 20 rem, with trash; the menu has
                  both. Its toggles share one saving state with the menu's
                  «Label» (#347). */}
              {!isRSS && (
                <LabelPicker
                  threadId={activeThread.thread_id}
                  applied={activeThread.labels ?? []}
                  labelToggle={labelToggle}
                  className="hidden @min-[20rem]:block"
                />
              )}
            </>
          )}
          {/* Never gives way, to a narrow header or to the search (ADR-0068
              §3): the mail boundary tests expect it on screen at every width
              (#347). */}
          {!isRSS && (
            <IconButton
              icon={Archive}
              disabled={changesBlocked}
              label={t('threads.actions.archiveThread')}
              onClick={() => void archiveThread(activeThread.thread_id)}
            />
          )}
          {!threadSearchOpen && (
            <>
              {!isRSS && (
                <>
                  {/* Junk is filed less often than it is archived, so it gives
                      way before the others (#245); the menu below keeps it.
                      30rem is where the whole row still fits beside the back
                      button of the narrow layout. Junk is mailbox management,
                      which Graph does not offer at all (#141), hence the
                      stricter test than the neighbours'. */}
                  {offersJunk && (
                    <IconButton
                      icon={Ban}
                      disabled={readOnly}
                      label={junkLabel}
                      className="hidden @min-[30rem]:flex"
                      onClick={toggleJunk}
                    />
                  )}
                  <IconButton
                    icon={Trash2}
                    disabled={changesBlocked}
                    label={t('threads.actions.moveToTrash')}
                    className="hidden @min-[20rem]:flex"
                    onClick={() => void deleteThread(activeThread.thread_id)}
                  />
                </>
              )}
            </>
          )}
          {/* Gives way last, with search; the line under the subject, `i` and
              the menu also open the panel. */}
          <IconButton
            icon={PanelRight}
            label={isRSS ? t('chat.feedDetails') : t('chat.conversationDetails')}
            active={detailsOpen}
            aria-expanded={detailsOpen}
            className="hidden @min-[16rem]:flex"
            onClick={toggleConversationPanel}
          />
          <div ref={actionsMenuRef} className="relative">
            <IconButton
              icon={MoreVertical}
              label={t('chat.moreActions')}
              active={actionsMenuOpen}
              aria-haspopup="menu"
              aria-expanded={actionsMenuOpen}
              onClick={() => setActionsMenuOpen((open) => !open)}
            />
            {actionsMenuOpen && (
              <MenuList
                label={t('chat.moreActions')}
                autoFocus
                tabStop
                onClose={() => setActionsMenuOpen(false)}
                style={actionsMenuMaxHeight === null ? undefined : { maxHeight: actionsMenuMaxHeight }}
                // No wider than the header, and no taller than the room under
                // it (above): the reader clips what overflows it, and at the
                // app's 200 % 13 rem is wider than a 360 px reader (#347).
                className="absolute end-0 top-full z-50 mt-2 w-52 max-w-[calc(100cqw-1rem)] overflow-y-auto rounded-control border border-border bg-chats p-1 shadow-overlay"
              >
                {/* How the conversation is shown: one of two, the one in force checked. */}
                <MenuItem
                  role="menuitemradio"
                  checked={conversationMode === 'html'}
                  appearance={conversationMode === 'html' ? menuItemCurrentClass : undefined}
                  icon={<Code size={14} className="shrink-0" strokeWidth={1.75} />}
                  label={t('chat.viewAsHtml')}
                  onClick={() => {
                    setQuickConversationMode('html')
                    setActionsMenuOpen(false)
                  }}
                />
                <MenuItem
                  role="menuitemradio"
                  checked={conversationMode === 'plain'}
                  appearance={conversationMode === 'plain' ? menuItemCurrentClass : undefined}
                  icon={<FileText size={14} className="shrink-0" strokeWidth={1.75} />}
                  label={t('chat.viewAsPlainText')}
                  onClick={() => {
                    setQuickConversationMode('plain')
                    setActionsMenuOpen(false)
                  }}
                />
                <MenuSeparator />
                <MenuItem
                  icon={<Printer size={14} className="shrink-0" strokeWidth={1.75} />}
                  label={t('print.action')}
                  onClick={() => {
                    setActionsMenuOpen(false)
                    // As General → Print says: the whole conversation by
                    // default, since a printout of one message out of twelve
                    // is a printout of a fragment (ADR-0060).
                    void printFromReader(activeThread)
                  }}
                />
                <MenuItem
                  disabled={changesBlocked}
                  icon={
                    <Star
                      size={14}
                      className={`shrink-0 ${activeThread.starred ? 'fill-warning text-warning' : ''}`}
                      strokeWidth={1.75}
                    />
                  }
                  label={activeThread.starred ? t('chat.unstar') : t('chat.star')}
                  onClick={() => {
                    void starThread(activeThread.thread_id, !activeThread.starred)
                    setActionsMenuOpen(false)
                  }}
                />
                {!isRSS && (
                  <>
                    <MenuItem
                      disabled={changesBlocked}
                      icon={<Archive size={14} className="shrink-0" strokeWidth={1.75} />}
                      label={t('threads.actions.archiveThread')}
                      onClick={() => {
                        void archiveThread(activeThread.thread_id)
                        setActionsMenuOpen(false)
                      }}
                    />
                    {offersJunk && (
                      <MenuItem
                        disabled={readOnly}
                        icon={<Ban size={14} className="shrink-0" strokeWidth={1.75} />}
                        label={junkLabel}
                        onClick={() => {
                          toggleJunk()
                          setActionsMenuOpen(false)
                        }}
                      />
                    )}
                    <MenuItem
                      danger
                      disabled={changesBlocked}
                      icon={<Trash2 size={14} className="shrink-0" strokeWidth={1.75} />}
                      label={t('threads.actions.moveToTrash')}
                      onClick={() => {
                        void deleteThread(activeThread.thread_id)
                        setActionsMenuOpen(false)
                      }}
                    />
                  </>
                )}
                {/* Search, label and details, which a narrow header hides
                    (#347), only while they are hidden: the same container
                    widths as above, like the kanban board menu's filters.
                    The menu keyboard skips rows that are not shown. */}
                <div role="none" className={isRSS ? '@min-[16rem]:hidden' : '@min-[20rem]:hidden'}>
                  <MenuSeparator />
                  {!threadSearchOpen && (
                    <div role="none" className="@min-[16rem]:hidden">
                      <MenuItem
                        icon={<Search size={14} className="shrink-0" strokeWidth={1.75} />}
                        label={t('chat.searchThread')}
                        onClick={() => {
                          setActionsMenuOpen(false)
                          thread$.searchOpen.set(true)
                        }}
                      />
                    </div>
                  )}
                  {!isRSS && (
                    <SubmenuItem
                      icon={<Tag size={14} className="shrink-0" strokeWidth={1.75} />}
                      label={t('labels.label')}
                      dataAttribute={ACTIONS_MENU_ATTRIBUTE}
                      width={labelMenuWidth}
                      panelClassName="fixed z-[51] max-h-[calc(100vh-1rem)] w-56 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-control border border-border bg-chats p-1 shadow-overlay animate-fade-in"
                    >
                      <LabelMenuItems
                        applied={activeThread.labels ?? []}
                        {...labelToggle}
                        onManage={() => {
                          setActionsMenuOpen(false)
                          ui$.settingsOpen.set(true)
                        }}
                      />
                    </SubmenuItem>
                  )}
                  <div role="none" className="@min-[16rem]:hidden">
                    <MenuItem
                      role="menuitemcheckbox"
                      checked={detailsOpen}
                      icon={<PanelRight size={14} className="shrink-0" strokeWidth={1.75} />}
                      label={isRSS ? t('chat.feedDetails') : t('chat.conversationDetails')}
                      trailing={
                        detailsOpen ? (
                          <Check size={14} className="shrink-0 text-accent-fg" strokeWidth={1.75} />
                        ) : undefined
                      }
                      onClick={() => {
                        setActionsMenuOpen(false)
                        toggleConversationPanel()
                      }}
                    />
                  </div>
                </div>
              </MenuList>
            )}
          </div>
        </div>
      </header>
      {assistantOpen && <AssistantReviewDialog messages={threadMessages} onClose={() => setAssistantOpen(false)} />}
      {senderMenu && !isRSS && (
        <FloatingContextMenu
          x={senderMenu.x}
          y={senderMenu.y}
          label={senderDisplayName || t('composer.fields.from')}
          onClose={() => setSenderMenu(null)}
          overlay
          overlayClassName="fixed inset-0 z-[60]"
          className="fixed z-[61] min-w-[180px] rounded-control border border-border bg-chats p-1 shadow-overlay"
          onContextMenu={(event) => event.preventDefault()}
        >
          <MenuItem
            icon={<Copy size={14} className="text-accent-fg" strokeWidth={1.75} />}
            label={t('chat.copyName', { defaultValue: 'Copy name' })}
            disabled={!senderDisplayName}
            onClick={() => {
              copyHeaderText(senderDisplayName, 'Name copied')
              setSenderMenu(null)
            }}
          />
          <MenuItem
            icon={<Mail size={14} className="text-accent-fg" strokeWidth={1.75} />}
            label={t('chat.copyEmailAddress')}
            disabled={!senderEmail}
            onClick={() => {
              copyHeaderText(senderEmail, 'Email copied')
              setSenderMenu(null)
            }}
          />
          <MenuItem
            icon={<Search size={14} className="text-accent-fg" strokeWidth={1.75} />}
            label={t('chat.viewMessagesWith', { name: senderDisplayName })}
            disabled={!senderEmail}
            onClick={() => {
              openCorrespondentMail(activeThread.account_id, activeThread.folder_id, senderEmail)
              setSenderMenu(null)
            }}
          />
          <MenuItem
            icon={<SquarePen size={14} className="text-accent-fg" strokeWidth={1.75} />}
            label={t('chat.newMessageTo', { email: senderEmail })}
            disabled={!senderEmail || sendingBlocked}
            onClick={() => {
              openComposeTab({ accountId: activeThread.account_id, to: senderRecipient })
              setSenderMenu(null)
            }}
          />
        </FloatingContextMenu>
      )}
    </>
  )
}
