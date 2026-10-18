import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useValue } from '@legendapp/state/react'
import {
  CalendarDays,
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
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { openExternal } from '../../lib/native'
import { DETAILS_PANEL_WIDTH, sidebarLayout } from '../../lib/paneResize'
import { downloadAttachment } from '../../states/mail'
import { settings$ } from '../../states/settings'
import { ui$, type SidebarSection } from '../../states/ui'
import { Avatar } from '../avatar/Avatar'
import { IconButton } from '../button/IconButton'
import { FloatingContextMenu } from '../menu/FloatingContextMenu'
import { MenuItem } from '../menu/MenuItem'
import { PaneResizer } from '../resizer/PaneResizer'
import { useElementWidth, useWideWindow } from '../resizer/useElementWidth'
import { fileIconFor, formatFileSize } from './messageHelpers'
import { PersonHistory } from './PersonHistory'
import { SidebarAgenda } from './SidebarAgenda'

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
  onClose: () => void
  /** The open conversation's account: a person's history is this account's only (#86). */
  accountId?: string
  onOpenConversation?: (threadId: string, folder: string) => void
  onOpenEvent?: (start: number) => void
}

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
  onClose,
  accountId,
  onOpenConversation,
  onOpenEvent,
}: ConversationDetailsPanelProps) {
  const { t } = useTranslation()
  // The section is remembered across restarts (ADR-0059); one person's history
  // sits on top of it and is not, as it needs that person.
  const section = useValue(ui$.sidebarSection)
  const [person, setPerson] = useState<Participant | null>(null)
  const view = person ? 'person' : section
  const setView = (next: SidebarSection) => {
    setPerson(null)
    ui$.sidebarSection.set(next)
  }
  const [personMenu, setPersonMenu] = useState<{ x: number; y: number; person: Participant } | null>(null)
  const asideRef = useRef<HTMLElement | null>(null)
  const storedWidth = useValue(settings$.detailsPanelWidth)
  // Beside the reader on a wide window where its row leaves the reader its
  // room; an overlay otherwise, the board's narrow conversation pane included.
  const { beside, max } = sidebarLayout(useWideWindow(1100), useElementWidth(asideRef, true))
  const width = beside ? Math.min(storedWidth, max) : storedWidth

  // Another conversation may not have this person in it.
  useEffect(() => {
    setPerson(null)
  }, [scopeTitle])

  // Close the overlay drawer on Escape (matches the gallery/search behavior).
  useEscapeKey(onClose)

  return (
    <>
      {/* Backdrop — only where the panel is an overlay. */}
      {!beside && <div className="absolute inset-0 z-20 bg-black/40 animate-fade-in" onClick={onClose} />}

      {/* As an overlay it sits above the conversation header (z-40), which
          otherwise hid its own header: the title, Back and Close. */}
      <aside
        ref={asideRef}
        data-details-panel
        data-region="sidebar"
        data-layout={beside ? 'beside' : 'overlay'}
        style={{ '--details-panel-width': `${width}px` } as CSSProperties}
        className={`flex w-[var(--details-panel-width)] shrink-0 flex-col border-s border-border bg-header animate-slide-in-end ${
          beside ? 'relative' : 'absolute inset-y-0 end-0 z-50 max-w-[85vw] shadow-overlay'
        }`}
      >
        {/* Resizable beside the reader only; as an overlay it is capped to the window. */}
        <PaneResizer
          label={t('layout.resizeDetails')}
          value={width}
          limits={{ min: DETAILS_PANEL_WIDTH.min, max }}
          edge="start"
          sizeAt={(clientX, rtl) => {
            const rect = asideRef.current?.getBoundingClientRect()
            if (!rect) return width
            return rtl ? clientX - rect.left : rect.right - clientX
          }}
          onResize={(size) => settings$.detailsPanelWidth.set(size)}
          className={`absolute start-0 top-0 h-full -translate-x-1 rtl:translate-x-1 ${beside ? '' : 'hidden'}`}
        />
        {/* Header */}
        {view === 'overview' ? (
          <div className="flex h-12 shrink-0 items-center justify-end border-b border-border px-4">
            <IconButton icon={X} iconSize={20} label={t('chat.closeEsc')} onClick={onClose} />
          </div>
        ) : (
          <div className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-bold text-primary">
                {view === 'media'
                  ? t('chat.media')
                  : view === 'person' && person
                    ? t('person.title', { name: person.name || person.email, defaultValue: 'With {name}' })
                    : view === 'agenda'
                      ? t('sidebar.agenda')
                      : t('chat.files')}
              </h3>
              {view === 'agenda' ? (
                <p className="mt-0.5 truncate text-caption font-medium text-secondary">{t('sidebar.agendaRange')}</p>
              ) : (
                <p className="mt-0.5 truncate text-caption font-medium text-secondary" title={scopeTitle}>
                  {scopeTitle}
                </p>
              )}
              {view !== 'agenda' && scopeSubtitle && (
                <p className="truncate text-2xs text-secondary/80" title={scopeSubtitle}>
                  {scopeSubtitle}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <IconButton
                icon={ChevronLeft}
                iconSize={20}
                label={t('buttons.back')}
                onClick={() => setView('overview')}
              />
              <IconButton icon={X} iconSize={20} label={t('chat.closeEsc')} onClick={onClose} />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {view === 'agenda' ? (
            // Not about this conversation, so it does not wait for it to load.
            <SidebarAgenda />
          ) : loading ? (
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
              onOpenAgenda={() => setView('agenda')}
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
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control-sm bg-accent/10 text-accent">
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
      </aside>
      {personMenu && (
        <FloatingContextMenu
          x={personMenu.x}
          y={personMenu.y}
          onClose={() => setPersonMenu(null)}
          overlay
          overlayClassName="fixed inset-0 z-[80]"
          className="fixed z-[81] min-w-[180px] rounded-control border border-border bg-chats p-1 shadow-overlay"
          onContextMenu={(event) => event.preventDefault()}
        >
          {accountId && onOpenConversation && (
            <MenuItem
              icon={<MessageSquare size={14} className="text-accent" strokeWidth={1.75} />}
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
            icon={<Search size={14} className="text-accent" strokeWidth={1.75} />}
            label={t('chat.viewMessagesWith', { name: personMenu.person.name || personMenu.person.email })}
            onClick={() => {
              onViewMessagesWith(personMenu.person)
              setPersonMenu(null)
            }}
          />
          <MenuItem
            icon={<Copy size={14} className="text-accent" strokeWidth={1.75} />}
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
  onOpenAgenda,
  onComposeTo,
  onOpenPersonMenu,
}: {
  mediaCount: number
  filesCount: number
  participants: Participant[]
  onOpenMedia: () => void
  onOpenFiles: () => void
  onOpenAgenda: () => void
  onComposeTo: (person: Participant) => void
  onOpenPersonMenu: (menu: { x: number; y: number; person: Participant }) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="border-b border-border bg-chats p-3">
        <SummaryRow icon={CalendarDays} label={t('sidebar.agenda')} onClick={onOpenAgenda} />
        {mediaCount > 0 && (
          <SummaryRow icon={Image} label={t('chat.mediaItems', { count: mediaCount })} onClick={onOpenMedia} />
        )}
        {filesCount > 0 && (
          <SummaryRow icon={File} label={t('chat.fileItems', { count: filesCount })} onClick={onOpenFiles} />
        )}
      </div>
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
                <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px text-2xs font-bold uppercase tracking-wide text-accent">
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
