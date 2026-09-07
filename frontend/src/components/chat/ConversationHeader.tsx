import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'
import {
  Archive,
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
  Trash2,
  X,
  Printer,
} from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { showToast, ui$ } from '../../states/ui'
import {
  archiveThread,
  deleteThread,
  mail$,
  markThreadRead,
  markThreadUnread,
  starThread,
} from '../../states/mail'
import { printConversation } from '../../lib/print'
import { LabelPicker } from './LabelPicker'
import { thread$, type ConversationMode } from '../../states/thread'
import { closeKanbanPane, kanban$, openCorrespondentMail } from '../../states/kanban'
import { openComposeTab } from '../../states/compose'
import type { Message } from '../../types'
import { Avatar } from '../avatar/Avatar'
import { IconButton } from '../button/IconButton'
import { FloatingContextMenu } from '../menu/FloatingContextMenu'
import { MenuItem } from '../menu/MenuItem'
import { ConversationSubject } from './ConversationSubject'
import { ReadingHeaderSummary } from './ReadingHeaderSummary'
import { isConversation, summariseThread } from './readingHeader'
import { accountIdentities, accounts$ } from '../../states/accounts'

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
  const mediaOpen = useValue(thread$.mediaOpen)
  const normalizedThreadSearch = threadSearch.trim().toLowerCase()

  // The conversation as a whole, for the line under the subject. Derived from
  // the messages actually loaded plus the thread's own counts, so it stays
  // honest about a long thread whose older half is still on the server.
  const loadedMessages = useValue(mail$.messages)
  const messagesCursor = useValue(mail$.messagesCursor)
  const accounts = useValue(accounts$)
  const ownAddresses = accounts
    .filter((account) => account.id === activeThread.account_id)
    .flatMap((account) => accountIdentities(account).map((identity) => identity.email))
  const summary = summariseThread(activeThread, loadedMessages, !!messagesCursor, ownAddresses)

  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const [senderMenu, setSenderMenu] = useState<{ x: number; y: number } | null>(null)
  const actionsMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!actionsMenuOpen) return
    const onDown = (event: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(event.target as Node)) {
        setActionsMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [actionsMenuOpen])

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
      <header className="relative z-40 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-header px-2 select-none">
        <button
          className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-hover text-secondary min-[769px]:hidden cursor-pointer"
          onClick={() => ui$.mobilePane.set('threads')}
          title={t('chat.backToChats')}
        >
          <ChevronLeft size={20} />
        </button>

        {inKanban && (
          <button
            className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-hover text-secondary cursor-pointer max-[600px]:hidden"
            onClick={closeKanbanPane}
            title={t('chat.closeConversationEsc')}
          >
            <X size={18} />
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
              detailsOpen={mediaOpen}
              onOpenDetails={() => thread$.mediaOpen.set(!mediaOpen)}
            />
          ) : (
            <button
              type="button"
              onClick={openSenderMenu}
              onContextMenu={openSenderMenu}
              className="mt-0.5 block max-w-full truncate rounded-sm text-left text-xs font-medium text-secondary outline-none transition-colors cursor-context-menu hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/40"
              title={`${activeThread.from_name} (${activeThread.from_addr})`}
              aria-label={t('chat.copyFullAddress')}
            >
              {senderName ? (
                <>
                  {senderName} <span className="opacity-70">({senderEmail})</span>
                </>
              ) : (
                senderEmail
              )}
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!threadSearchOpen ? (
            <IconButton icon={Search} label={t('chat.searchThread')} onClick={() => thread$.searchOpen.set(true)} />
          ) : (
            <div className="hidden min-[900px]:flex w-[286px] items-center gap-1 rounded-control bg-hover px-2 py-1.5 border border-transparent focus-within:border-accent/40 focus-within:bg-chats">
              <Search size={14} className="text-secondary shrink-0" />
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
                <X size={12} />
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
                <ChevronUp size={14} />
              </button>
              <button
                onClick={() => goToSearchMatch(1)}
                disabled={searchMatches.length === 0}
                className="flex h-6 w-6 items-center justify-center rounded-control-sm text-secondary hover:bg-active disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                title={t('chat.nextMatch')}
              >
                <ChevronDown size={14} />
              </button>
            </div>
          )}
          {/* The actions a reader reaches for constantly, as buttons rather
              than as three lines inside a menu. Archiving a conversation
              should not cost two clicks and a read of five other options.
              They step aside while the thread search is open, which needs the
              width more than they do. */}
          {!threadSearchOpen && (
            <>
              {/* The two that give way first when the pane is narrow. They
                  stay in the menu below, so nothing becomes unreachable —
                  only less immediate. */}
              <IconButton
                icon={Star}
                label={activeThread.starred ? t('chat.unstar') : t('chat.star')}
                className={clsx('hidden min-[860px]:flex', activeThread.starred && 'text-amber-500')}
                onClick={() => void starThread(activeThread.thread_id, !activeThread.starred)}
              />
              <IconButton
                icon={activeThread.unread ? MailOpen : Mail}
                label={activeThread.unread ? t('threads.actions.markAsRead') : t('threads.actions.markAsUnread')}
                className="hidden min-[860px]:flex"
                onClick={() =>
                  void (activeThread.unread
                    ? markThreadRead(activeThread.thread_id)
                    : markThreadUnread(activeThread.thread_id))
                }
              />
              {!isRSS && (
                <>
                  <LabelPicker threadId={activeThread.thread_id} applied={activeThread.labels ?? []} />
                  <IconButton
                    icon={Archive}
                    label={t('threads.actions.archiveThread')}
                    onClick={() => void archiveThread(activeThread.thread_id)}
                  />
                  <IconButton
                    icon={Trash2}
                    label={t('threads.actions.moveToTrash')}
                    onClick={() => void deleteThread(activeThread.thread_id)}
                  />
                </>
              )}
            </>
          )}
          <IconButton
            icon={PanelRight}
            label={isRSS ? t('chat.feedDetails') : t('chat.conversationDetails')}
            active={mediaOpen}
            onClick={() => thread$.mediaOpen.set(!mediaOpen)}
          />
          <div ref={actionsMenuRef} className="relative">
            <IconButton
              icon={MoreVertical}
              label={t('chat.moreActions')}
              active={actionsMenuOpen}
              onClick={() => setActionsMenuOpen((open) => !open)}
            />
            {actionsMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-control border border-border bg-chats p-1 shadow-xl">
                <button
                  onClick={() => {
                    setQuickConversationMode('html')
                    setActionsMenuOpen(false)
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-control-sm px-3 py-2 text-xs cursor-pointer hover:bg-hover ${
                    conversationMode === 'html' ? 'font-semibold text-accent' : 'font-medium text-primary'
                  }`}
                >
                  <Code size={15} className="shrink-0" /> {t('chat.viewAsHtml')}
                </button>
                <button
                  onClick={() => {
                    setQuickConversationMode('plain')
                    setActionsMenuOpen(false)
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-control-sm px-3 py-2 text-xs cursor-pointer hover:bg-hover ${
                    conversationMode === 'plain' ? 'font-semibold text-accent' : 'font-medium text-primary'
                  }`}
                >
                  <FileText size={15} className="shrink-0" /> {t('chat.viewAsPlainText')}
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  onClick={() => {
                    setActionsMenuOpen(false)
                    void printConversation({
                      subject: activeThread.subject,
                      // Every message of the conversation, in the order they
                      // were written: a printout of one message out of twelve
                      // is a printout of a fragment.
                      messages: mail$.messages
                        .peek()
                        .filter((message) => message.thread_id === activeThread.thread_id),
                      printedLabel: t('print.printedOn'),
                      toLabel: t('print.to'),
                      ccLabel: t('print.cc'),
                      attachmentsLabel: t('print.attachments'),
                    })
                  }}
                  className="flex w-full items-center gap-2.5 rounded-control-sm px-3 py-2 text-xs font-medium text-primary cursor-pointer hover:bg-hover"
                >
                  <Printer size={15} className="shrink-0" /> {t('print.action')}
                </button>
                <button
                  onClick={() => {
                    void starThread(activeThread.thread_id, !activeThread.starred)
                    setActionsMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-2.5 rounded-control-sm px-3 py-2 text-xs font-medium text-primary cursor-pointer hover:bg-hover"
                >
                  <Star
                    size={15}
                    className={`shrink-0 ${activeThread.starred ? 'fill-amber-500 text-amber-500' : ''}`}
                  />
                  {activeThread.starred ? t('chat.unstar') : t('chat.star')}
                </button>
                {!isRSS && (
                  <>
                    <button
                      onClick={() => {
                        void archiveThread(activeThread.thread_id)
                        setActionsMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2.5 rounded-control-sm px-3 py-2 text-xs font-medium text-primary cursor-pointer hover:bg-hover"
                    >
                      <Archive size={15} className="shrink-0" /> {t('threads.actions.archiveThread')}
                    </button>
                    <button
                      onClick={() => {
                        void deleteThread(activeThread.thread_id)
                        setActionsMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2.5 rounded-control-sm px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-400 cursor-pointer hover:bg-rose-50 dark:hover:bg-rose-950/25"
                    >
                      <Trash2 size={15} className="shrink-0" /> {t('threads.actions.moveToTrash')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      {senderMenu && !isRSS && (
        <FloatingContextMenu
          x={senderMenu.x}
          y={senderMenu.y}
          onClose={() => setSenderMenu(null)}
          overlay
          overlayClassName="fixed inset-0 z-[60]"
          className="fixed z-[61] min-w-[180px] rounded-control border border-border bg-header p-1 shadow-xl"
          onContextMenu={(event) => event.preventDefault()}
        >
          <MenuItem
            icon={<Copy size={13} className="text-accent" />}
            label={t('chat.copyName', { defaultValue: 'Copy name' })}
            disabled={!senderDisplayName}
            onClick={() => {
              copyHeaderText(senderDisplayName, 'Name copied')
              setSenderMenu(null)
            }}
          />
          <MenuItem
            icon={<Mail size={13} className="text-accent" />}
            label={t('chat.copyEmailAddress')}
            disabled={!senderEmail}
            onClick={() => {
              copyHeaderText(senderEmail, 'Email copied')
              setSenderMenu(null)
            }}
          />
          <MenuItem
            icon={<Search size={13} className="text-accent" />}
            label={t('chat.viewMessagesWith', { name: senderDisplayName })}
            disabled={!senderEmail}
            onClick={() => {
              openCorrespondentMail(activeThread.account_id, activeThread.folder_id, senderEmail)
              setSenderMenu(null)
            }}
          />
          <MenuItem
            icon={<SquarePen size={13} className="text-accent" />}
            label={t('chat.newMessageTo', { email: senderEmail })}
            disabled={!senderEmail}
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
