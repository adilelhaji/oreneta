import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useValue } from '@legendapp/state/react'
import {
  ChevronLeft,
  Copy,
  Download,
  File,
  Image,
  Loader2,
  MessageSquare,
  Play,
  Search,
  SquarePen,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { openExternal } from '../../lib/native'
import { calendar$, startOfDay } from '../../states/calendar'
import { compose$, openComposeTab, withoutHydratedQuickReplyDraft } from '../../states/compose'
import { openCorrespondentMail, openMailAccount } from '../../states/kanban'
import { downloadAttachment, mail$ } from '../../states/mail'
import { closeSidebarOverlay } from '../../states/sidebar'
import { thread$ } from '../../states/thread'
import { isConversationSection, ui$, type ConversationSection } from '../../states/ui'
import { Avatar } from '../avatar/Avatar'
import { IconButton } from '../button/IconButton'
import { FloatingContextMenu } from '../menu/FloatingContextMenu'
import { MenuItem } from '../menu/MenuItem'
import { useActiveConversation } from './activeConversation'
import { buildParticipants, buildThreadMedia } from './conversationMedia'
import { fileIconFor, formatFileSize } from './messageHelpers'
import { PersonHistory } from './PersonHistory'

export type ConversationMediaItem = {
  type: 'image' | 'video'
  src: string
  filename: string
  // External/source URL, used to open videos the in-app webview can't decode.
  url?: string
  // Index into the thread-wide gallery list so a thumbnail can open the same
  // lightbox the message bubbles use.
  galleryIndex?: number
  messageId: string
}

export type ConversationFileItem = {
  filename: string
  mime: string
  size: number
  // Media key for the on-disk bytes; null when the file wasn't persisted.
  key: string | null
  messageId: string
}

export type Participant = {
  name: string
  email: string
  /** How many of the thread's messages this address appears on (From/To/Cc). */
  count: number
  /** True when the address belongs to one of the user's own accounts. */
  isSelf: boolean
}

interface ConversationDetailsPanelProps {
  media: ConversationMediaItem[]
  files: ConversationFileItem[]
  participants: Participant[]
  scopeTitle: string
  scopeSubtitle?: string
  /** True while a freshly selected thread is still loading; the lists below
   * belong to the previous thread until it resolves. */
  loading: boolean
  onOpenImage: (galleryIndex: number) => void
  onShowInConversation: (messageId: string) => void
  onComposeTo: (person: Participant) => void
  onViewMessagesWith: (person: Participant) => void
  /** The open conversation's account: a person's history is this account's only (#86). */
  accountId?: string
  onOpenConversation?: (threadId: string, folder: string) => void
  onOpenEvent?: (start: number) => void
}

/**
 * The Conversa panel of the app's sidebar (ADR-0069 §1): the conversation's
 * summary (its participants), media and files, the subsections the details
 * sidebar had (ADR-0059). The subsection is remembered across restarts
 * (`session_sidebar_section_main`); one person's history (#86) sits on top of
 * it and is not, as it needs that person, until the Persona panel (12c).
 */
export function ConversationDetailsPanel({
  media,
  files,
  participants,
  scopeTitle,
  scopeSubtitle,
  loading,
  onOpenImage,
  onShowInConversation,
  onComposeTo,
  onViewMessagesWith,
  accountId,
  onOpenConversation,
  onOpenEvent,
}: ConversationDetailsPanelProps) {
  const { t } = useTranslation()
  const stored = useValue(ui$.sidebarSection)
  const section: ConversationSection = isConversationSection(stored) ? stored : 'overview'
  const [person, setPerson] = useState<Participant | null>(null)
  const view = person ? 'person' : section
  const setView = (next: ConversationSection) => {
    setPerson(null)
    ui$.sidebarSection.set(next)
  }
  const [personMenu, setPersonMenu] = useState<{ x: number; y: number; person: Participant } | null>(null)

  // Another conversation may not have this person in it.
  useEffect(() => {
    setPerson(null)
  }, [scopeTitle])

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* A subsection's own header: what it is, the conversation, and back to the summary. */}
        {view !== 'overview' && (
          <div className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-bold text-primary">
                {view === 'media'
                  ? t('chat.media')
                  : view === 'person' && person
                    ? t('person.title', { name: person.name || person.email, defaultValue: 'With {name}' })
                    : t('chat.files')}
              </h3>
              <p className="mt-0.5 truncate text-caption font-medium text-secondary" title={scopeTitle}>
                {scopeTitle}
              </p>
              {scopeSubtitle && (
                <p className="truncate text-2xs text-secondary/80" title={scopeSubtitle}>
                  {scopeSubtitle}
                </p>
              )}
            </div>
            <IconButton
              icon={ChevronLeft}
              iconSize={20}
              label={t('buttons.back')}
              className="shrink-0"
              onClick={() => setView('overview')}
            />
          </div>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={20} className="animate-spin text-secondary" strokeWidth={1.75} />
            </div>
          ) : view === 'overview' ? (
            <Overview
              mediaCount={media.length}
              filesCount={files.length}
              participants={participants}
              onOpenMedia={() => setView('media')}
              onOpenFiles={() => setView('files')}
              onComposeTo={onComposeTo}
              onOpenPersonMenu={setPersonMenu}
            />
          ) : view === 'person' && person && accountId && onOpenConversation && onOpenEvent ? (
            <PersonHistory
              accountId={accountId}
              address={person.email}
              onOpenConversation={onOpenConversation}
              onOpenEvent={onOpenEvent}
            />
          ) : view === 'media' ? (
            media.length === 0 ? (
              <EmptyHint text={t('chat.noMedia')} />
            ) : (
              <div className="grid grid-cols-3 gap-1.5 p-3">
                {media.map((item, idx) => (
                  <div
                    key={idx}
                    className="group relative aspect-square overflow-hidden rounded-md border border-border/30 bg-black/5 dark:bg-white/5 [content-visibility:auto] [contain-intrinsic-size:auto_none]"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (item.galleryIndex !== undefined) {
                          onOpenImage(item.galleryIndex)
                        } else if (item.url) {
                          openExternal(item.url)
                        }
                      }}
                      className="h-full w-full hover:opacity-90 cursor-pointer"
                      title={item.filename}
                    >
                      {item.type === 'image' ? (
                        <img
                          src={item.src}
                          alt={item.filename}
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        // Static tile — never a live <video>. Each <video> spins up a
                        // GStreamer pipeline in WebKitGTK; a grid of them freezes the
                        // webview. Click opens the lightbox, which mounts one player.
                        <span className="flex h-full w-full items-center justify-center bg-black/75 text-white/90">
                          <Play size={20} fill="currentColor" strokeWidth={1.75} />
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onShowInConversation(item.messageId)}
                      title={t('chat.showInConversation')}
                      aria-label={t('chat.showInConversation')}
                      className="absolute end-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/65 text-white shadow-sm transition-colors hover:bg-accent hover:text-on-accent cursor-pointer"
                    >
                      <MessageSquare size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : files.length === 0 ? (
            <EmptyHint text={t('chat.noFiles')} />
          ) : (
            <div className="flex flex-col gap-1.5 p-3">
              {files.map((file, idx) => {
                const downloadable = !!file.key
                const FileIcon = fileIconFor(file.filename, file.mime)
                return (
                  <div
                    key={idx}
                    className="group flex items-center rounded-control border border-border/30 bg-black/[0.02] dark:bg-white/[0.02]"
                  >
                    <button
                      type="button"
                      disabled={!downloadable}
                      onClick={() => downloadAttachment(file)}
                      title={downloadable ? t('chat.saveFile', { filename: file.filename }) : file.filename}
                      className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-s-xl p-2.5 text-start ${
                        downloadable
                          ? 'hover:bg-black/[0.05] dark:hover:bg-white/[0.05] cursor-pointer'
                          : 'cursor-default'
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control-sm bg-accent/10 text-accent-fg">
                        <FileIcon size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p dir="auto" className="truncate text-xs font-semibold text-primary">{file.filename}</p>
                        <p className="text-2xs text-secondary">{formatFileSize(file.size)}</p>
                      </div>
                      {downloadable && (
                        <Download
                          size={16}
                          className="shrink-0 text-secondary opacity-0 group-hover:opacity-100 transition-opacity"
                          strokeWidth={1.75}
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onShowInConversation(file.messageId)}
                      title={t('chat.showInConversation')}
                      aria-label={t('chat.showInConversation')}
                      className="me-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-black/[0.06] hover:text-primary dark:hover:bg-white/[0.08] cursor-pointer"
                    >
                      <MessageSquare size={16} strokeWidth={1.75} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      {personMenu && (
        <FloatingContextMenu
          x={personMenu.x}
          y={personMenu.y}
          label={personMenu.person.name || personMenu.person.email}
          onClose={() => setPersonMenu(null)}
          overlay
          overlayClassName="fixed inset-0 z-[80]"
          className="fixed z-[81] min-w-[180px] rounded-control border border-border bg-chats p-1 shadow-overlay"
          onContextMenu={(event) => event.preventDefault()}
        >
          {accountId && onOpenConversation && (
            <MenuItem
              icon={<MessageSquare size={14} className="text-accent-fg" strokeWidth={1.75} />}
              label={t('person.history', {
                name: personMenu.person.name || personMenu.person.email,
                defaultValue: 'History with {name}',
              })}
              onClick={() => {
                setPerson(personMenu.person)
                setPersonMenu(null)
              }}
            />
          )}
          <MenuItem
            icon={<Search size={14} className="text-accent-fg" strokeWidth={1.75} />}
            label={t('chat.viewMessagesWith', { name: personMenu.person.name || personMenu.person.email })}
            onClick={() => {
              onViewMessagesWith(personMenu.person)
              setPersonMenu(null)
            }}
          />
          <MenuItem
            icon={<Copy size={14} className="text-accent-fg" strokeWidth={1.75} />}
            label={t('chat.copyEmailAddress')}
            onClick={() => {
              navigator.clipboard?.writeText(personMenu.person.email).catch(() => undefined)
              setPersonMenu(null)
            }}
          />
        </FloatingContextMenu>
      )}
    </>
  )
}

function Overview({
  mediaCount,
  filesCount,
  participants,
  onOpenMedia,
  onOpenFiles,
  onComposeTo,
  onOpenPersonMenu,
}: {
  mediaCount: number
  filesCount: number
  participants: Participant[]
  onOpenMedia: () => void
  onOpenFiles: () => void
  onComposeTo: (person: Participant) => void
  onOpenPersonMenu: (menu: { x: number; y: number; person: Participant }) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      {/* The agenda is a panel of its own now (ADR-0069 §1), no longer a row here. */}
      {(mediaCount > 0 || filesCount > 0) && (
        <div className="border-b border-border bg-chats p-3">
          {mediaCount > 0 && (
            <SummaryRow icon={Image} label={t('chat.mediaItems', { count: mediaCount })} onClick={onOpenMedia} />
          )}
          {filesCount > 0 && (
            <SummaryRow icon={File} label={t('chat.fileItems', { count: filesCount })} onClick={onOpenFiles} />
          )}
        </div>
      )}
      <div className="p-3">
        <div className="mb-2 flex items-center gap-2 px-2 text-caption font-bold uppercase tracking-wide text-secondary">
          <Users size={16} strokeWidth={1.75} />
          <span>{t('chat.people', { count: participants.length })}</span>
        </div>
        <PeopleList participants={participants} onComposeTo={onComposeTo} onOpenPersonMenu={onOpenPersonMenu} />
      </div>
    </div>
  )
}

function SummaryRow({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-3 rounded-control-sm px-2 py-3 text-start text-sm font-medium text-primary hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
    >
      <Icon size={21} className="shrink-0" />
      <span>{label}</span>
    </button>
  )
}

function PeopleList({
  participants,
  onComposeTo,
  onOpenPersonMenu,
}: {
  participants: Participant[]
  onComposeTo: (person: Participant) => void
  onOpenPersonMenu: (menu: { x: number; y: number; person: Participant }) => void
}) {
  const { t } = useTranslation()
  if (participants.length === 0) {
    return <EmptyHint text={t('chat.noParticipants')} />
  }

  const openMenu = (event: MouseEvent, person: Participant) => {
    event.preventDefault()
    onOpenPersonMenu({ x: event.clientX, y: event.clientY, person })
  }

  return (
    <div className="flex flex-col gap-0.5">
      {participants.map((person) => (
        <div
          key={person.email}
          onMouseDown={(event) => {
            if (event.button === 2) openMenu(event, person)
          }}
          onContextMenu={(event) => openMenu(event, person)}
          className="group flex items-center gap-3 rounded-control p-2 text-start hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
        >
          <Avatar name={person.name} email={person.email} size={36} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-primary selectable-text">
              <span dir="auto" className="truncate">{person.name}</span>
              {person.isSelf && (
                <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px text-2xs font-bold uppercase tracking-wide text-accent-fg">
                  {t('chat.you')}
                </span>
              )}
            </p>
            <p dir="auto" className="truncate text-caption text-secondary selectable-text">{person.email}</p>
          </div>
          <button
            type="button"
            onClick={() => onComposeTo(person)}
            title={t('chat.newMessageTo', { email: person.email })}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary opacity-0 transition-all hover:bg-black/[0.06] hover:text-primary group-hover:opacity-100 dark:hover:bg-white/[0.08] cursor-pointer"
          >
            <SquarePen size={16} strokeWidth={1.75} />
          </button>
        </div>
      ))}
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-xs text-secondary">{text}</div>
}

/**
 * The Conversa panel as the app's sidebar draws it: the open conversation's
 * details, read from the conversation pane's own state (the same messages,
 * gallery and account), and what each of them opens.
 */
export function ConversationPanel() {
  const { t } = useTranslation()
  const { accounts, activeThread, isRSS } = useActiveConversation()
  const messages = useValue(mail$.messages)
  const threadLoading = useValue(mail$.threadLoading)
  const revealedRemote = useValue(thread$.revealedRemote)
  const quickReplyDraftId = useValue(compose$.quickReplyDraftId)
  const quickReplyDraftSaved = useValue(compose$.quickReplyDraftSaved)
  // As the conversation pane shows them, so a media item's gallery index is
  // the one of the pane's gallery.
  const displayMessages = useMemo(
    () => withoutHydratedQuickReplyDraft(messages, quickReplyDraftId, quickReplyDraftSaved),
    [messages, quickReplyDraftId, quickReplyDraftSaved],
  )
  const { mediaItems, fileItems } = useMemo(
    () => buildThreadMedia(displayMessages, accounts, revealedRemote),
    [displayMessages, accounts, revealedRemote],
  )
  const participants = useMemo(
    () => buildParticipants(displayMessages, accounts, isRSS),
    [displayMessages, accounts, isRSS],
  )
  if (!activeThread) return null
  const accountId = activeThread.account_id
  // A freshly selected conversation still loading: the lists are the previous one's.
  const loading = threadLoading && !messages.some((message) => message.thread_id === activeThread.thread_id)
  return (
    <ConversationDetailsPanel
      media={mediaItems}
      files={fileItems}
      participants={participants}
      scopeTitle={activeThread.subject || t('threads.noSubject')}
      // For RSS, from_name duplicates the subject (both the feed title), so
      // show the feed host instead; otherwise show the sender name.
      scopeSubtitle={isRSS ? activeThread.from_addr : activeThread.from_name || activeThread.from_addr}
      loading={loading}
      onOpenImage={(index) => {
        // The gallery is the conversation pane's, under an overlay's inert
        // module: the overlay goes first, as for the message itself.
        closeSidebarOverlay()
        thread$.galleryIndex.set(index)
      }}
      onShowInConversation={(messageId) => {
        thread$.pendingScrollMessageId.set(messageId)
        thread$.galleryIndex.set(null)
        // The message is what is wanted now: an overlay over it goes.
        closeSidebarOverlay()
      }}
      onComposeTo={(person) => {
        // The new message opens in the conversation pane: an overlay over it goes.
        closeSidebarOverlay()
        openComposeTab({
          accountId,
          to: person.name && person.name !== person.email ? `${person.name} <${person.email}>` : person.email,
        })
      }}
      // The list of those messages is under an overlay: it closes it.
      onViewMessagesWith={(person) => openCorrespondentMail(accountId, activeThread.folder_id, person.email)}
      accountId={accountId}
      onOpenConversation={(threadId, folder) => {
        // A conversation from the person's history, under an overlay too.
        closeSidebarOverlay()
        openMailAccount(accountId, folder, false)
        ui$.selectedThread.set(threadId)
      }}
      // Calendar is another module, which closes an overlay as it opens.
      onOpenEvent={(start) => {
        calendar$.anchor.set(startOfDay(new Date(start * 1000)).getTime())
        calendar$.view.set('day')
        ui$.module.set('calendar')
      }}
    />
  )
}
