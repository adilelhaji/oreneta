import { useEffect, useState } from 'react'
import { Download, Eye, Mail, Paperclip, Search } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import {
  attachmentList$,
  loadAttachments,
  uncovered,
  type AttachmentKind,
  type ListedAttachment,
} from '../../states/attachmentList'
import { openMailAccount } from '../../states/kanban'
import { downloadAttachment } from '../../states/mail'
import { ui$ } from '../../states/ui'
import { previewKind } from '../../lib/attachmentPreview'
import { isRssAccount } from '../../lib/threadActions'
import { fileIconFor, formatFileSize } from '../chat/messageHelpers'
import { AttachmentPreviewDialog } from '../chat/AttachmentPreviewDialog'
import { EmptyState } from '../empty-state/EmptyState'
import { CompactNavigation } from '../sidenav/CompactNavigation'
import type { Attachment } from '../../types'

const KINDS: AttachmentKind[] = [
  '',
  'image',
  'pdf',
  'document',
  'spreadsheet',
  'presentation',
  'archive',
  'audio',
  'video',
  'calendar',
  'other',
]

function asAttachment(item: ListedAttachment): Attachment {
  return { filename: item.filename, mime: item.mime, size: item.size, key: item.key } as Attachment
}

/**
 * Every attachment of the mail kept here, across accounts (#93).
 *
 * Built from the messages downloaded to this computer, and it says how many
 * that is: mail never opened here has attachments nobody here knows about.
 * File contents are not searched.
 */
export function AttachmentsView() {
  const { t } = useTranslation()
  const filter = useValue(attachmentList$.filter)
  const items = useValue(attachmentList$.items)
  const total = useValue(attachmentList$.total)
  const coverage = useValue(attachmentList$.coverage)
  const loaded = useValue(attachmentList$.loaded)
  const loading = useValue(attachmentList$.loading)
  const accounts = useValue(accounts$).filter((account) => !isRssAccount(account, account.id))
  const [previewing, setPreviewing] = useState<Attachment | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => void loadAttachments(), filter.name || filter.sender ? 200 : 0)
    return () => clearTimeout(timer)
  }, [filter.account, filter.name, filter.sender, filter.kind, filter.within])

  const openMessage = (item: ListedAttachment) => {
    ui$.attachmentsOpen.set(false)
    openMailAccount(item.account, item.folder, false)
    ui$.selectedThread.set(item.thread_id)
    ui$.mobilePane.set('conversation')
  }

  const kindLabel = (kind: AttachmentKind) =>
    kind === ''
      ? t('attachmentsView.kindAll', { defaultValue: 'All types' })
      : t(`attachmentsView.kind.${kind}`, {
          defaultValue: {
            image: 'Images',
            pdf: 'PDF',
            document: 'Documents',
            spreadsheet: 'Spreadsheets',
            presentation: 'Presentations',
            archive: 'Archives',
            audio: 'Audio',
            video: 'Video',
            calendar: 'Calendar files',
            other: 'Other',
          }[kind],
        })

  const missing = uncovered(coverage)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-header px-4 py-3">
        <CompactNavigation />
        <h1 className="flex items-center gap-2 text-heading-sm font-bold text-primary">
          <Paperclip size={20} strokeWidth={1.75} />
          {t('attachmentsView.title', { defaultValue: 'Attachments' })}
        </h1>
        <span className="text-caption text-secondary" aria-live="polite">
          {loaded &&
            t('attachmentsView.count', {
              count: total,
              defaultValue: '{count, plural, one {# file} other {# files}}',
            })}
        </span>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-header px-4 py-2">
        <div className="flex min-w-40 flex-1 items-center gap-2 rounded-control border border-border bg-chats px-2.5 py-1.5 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-secondary" strokeWidth={1.75} />
          <input
            value={filter.name}
            onChange={(event) => attachmentList$.filter.name.set(event.target.value)}
            placeholder={t('attachmentsView.searchName', { defaultValue: 'File name' })}
            aria-label={t('attachmentsView.searchName', { defaultValue: 'File name' })}
            className="min-w-0 flex-1 bg-transparent text-caption text-primary placeholder-secondary outline-none"
          />
        </div>
        <input
          value={filter.sender}
          onChange={(event) => attachmentList$.filter.sender.set(event.target.value)}
          placeholder={t('attachmentsView.sender', { defaultValue: 'From' })}
          aria-label={t('attachmentsView.sender', { defaultValue: 'From' })}
          className="w-40 rounded-control border border-border bg-chats px-2.5 py-1.5 text-caption text-primary placeholder-secondary outline-none focus:border-accent"
        />
        <select
          value={filter.kind}
          onChange={(event) => attachmentList$.filter.kind.set(event.target.value as AttachmentKind)}
          aria-label={t('attachmentsView.type', { defaultValue: 'Type' })}
          className="rounded-control border border-border bg-chats px-2 py-1.5 text-caption text-primary"
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(kind)}
            </option>
          ))}
        </select>
        <select
          value={filter.within}
          onChange={(event) => attachmentList$.filter.within.set(Number(event.target.value))}
          aria-label={t('attachmentsView.when', { defaultValue: 'When' })}
          className="rounded-control border border-border bg-chats px-2 py-1.5 text-caption text-primary"
        >
          <option value={0}>{t('attachmentsView.anyTime', { defaultValue: 'Any time' })}</option>
          <option value={7}>{t('attachmentsView.lastWeek', { defaultValue: 'Last 7 days' })}</option>
          <option value={30}>{t('attachmentsView.lastMonth', { defaultValue: 'Last 30 days' })}</option>
          <option value={365}>{t('attachmentsView.lastYear', { defaultValue: 'Last year' })}</option>
        </select>
        {accounts.length > 1 && (
          <select
            value={filter.account}
            onChange={(event) => attachmentList$.filter.account.set(event.target.value)}
            aria-label={t('attachmentsView.account', { defaultValue: 'Account' })}
            className="rounded-control border border-border bg-chats px-2 py-1.5 text-caption text-primary"
          >
            <option value="">{t('attachmentsView.allAccounts', { defaultValue: 'All accounts' })}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.email}
              </option>
            ))}
          </select>
        )}
      </div>
      {missing > 0 && (
        <p className="shrink-0 border-b border-border bg-warning-soft px-4 py-2 text-caption text-primary">
          {t('attachmentsView.coverage', {
            missing,
            messages: coverage.messages,
            defaultValue:
              'Listed from the mail downloaded to this computer. {missing} of {messages} messages have not been downloaded yet, so their attachments are not here.',
          })}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loaded && items.length === 0 ? (
          <EmptyState
            title={t('attachmentsView.emptyTitle', { defaultValue: 'No attachments found' })}
            text={t('attachmentsView.emptyText', {
              defaultValue: 'File contents are not searched — only names, senders and dates.',
            })}
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {items.map((item) => {
              const Icon = fileIconFor(item.filename, item.mime)
              const name = item.filename || t('attachmentsView.unnamed', { defaultValue: 'Unnamed file' })
              return (
                <li
                  key={`${item.account}#${item.folder}#${item.uid}#${item.index}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-2.5"
                >
                  <Icon size={20} className="shrink-0 text-secondary" />
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="truncate text-ui font-semibold text-primary">{name}</p>
                    <p className="truncate text-caption text-secondary">
                      {[
                        formatFileSize(item.size),
                        item.from_name || item.from_addr,
                        new Date(item.date * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' }),
                        item.subject,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-1">
                    {item.key && previewKind(asAttachment(item)) && (
                      <button
                        type="button"
                        title={t('attachmentsView.preview', { defaultValue: 'Preview' })}
                        aria-label={t('attachmentsView.previewNamed', { name, defaultValue: 'Preview {name}' })}
                        onClick={() => setPreviewing(asAttachment(item))}
                        className="flex h-8 w-8 items-center justify-center rounded-control-sm text-secondary hover:bg-hover hover:text-primary cursor-pointer"
                      >
                        <Eye size={16} strokeWidth={1.75} />
                      </button>
                    )}
                    {item.key && (
                      <button
                        type="button"
                        title={t('attachmentsView.save', { defaultValue: 'Save' })}
                        aria-label={t('attachmentsView.saveNamed', { name, defaultValue: 'Save {name}' })}
                        onClick={() => void downloadAttachment({ key: item.key, filename: item.filename || 'file' })}
                        className="flex h-8 w-8 items-center justify-center rounded-control-sm text-secondary hover:bg-hover hover:text-primary cursor-pointer"
                      >
                        <Download size={16} strokeWidth={1.75} />
                      </button>
                    )}
                    <button
                      type="button"
                      title={t('attachmentsView.openMessage', { defaultValue: 'Open its message' })}
                      aria-label={t('attachmentsView.openMessageNamed', {
                        name,
                        defaultValue: 'Open the message with {name}',
                      })}
                      onClick={() => openMessage(item)}
                      className="flex h-8 w-8 items-center justify-center rounded-control-sm text-secondary hover:bg-hover hover:text-primary cursor-pointer"
                    >
                      <Mail size={16} strokeWidth={1.75} />
                    </button>
                  </span>
                  {!item.key && (
                    <p className="w-full pl-8 text-2xs text-secondary">
                      {item.unavailable === 'link'
                        ? t('attachmentsView.isLink', {
                            defaultValue: 'A link to a file kept elsewhere; open the message to follow it.',
                          })
                        : t('attachmentsView.notOnDisk', {
                            defaultValue: 'Not on this computer right now; opening its message downloads it again.',
                          })}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {items.length < total && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadAttachments(true)}
              className="rounded-control bg-hover px-3 py-1.5 text-caption font-semibold text-primary hover:bg-active disabled:opacity-50 cursor-pointer"
            >
              {t('attachmentsView.more', { defaultValue: 'Show more' })}
            </button>
          </div>
        )}
      </div>
      {previewing && <AttachmentPreviewDialog attachment={previewing} onClose={() => setPreviewing(null)} />}
    </div>
  )
}
