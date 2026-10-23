import { useEffect, useId, useState, type ChangeEvent } from 'react'
import { Download, Eye, Mail, Paperclip } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { intlLocale, useTranslation } from '../../lib/i18n'
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
import { useWideWindow } from '../resizer/useElementWidth'
import { useFolderPaneFocus } from '../shell/folderPaneFocus'
import { FOLDER_PANE_MIN_WINDOW, FolderPane } from '../shell/FolderPane'
import { clsx } from '../../lib/utils'
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
  const inPane = useWideWindow(FOLDER_PANE_MIN_WINDOW)
  useFolderPaneFocus(inPane)
  const fieldId = useId()

  useEffect(() => {
    const timer = setTimeout(() => void loadAttachments(), filter.name || filter.sender ? 200 : 0)
    return () => clearTimeout(timer)
  }, [filter.account, filter.name, filter.sender, filter.kind, filter.within])

  const openMessage = (item: ListedAttachment) => {
    ui$.module.set('mail')
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

  const kindOptions = KINDS.map((kind) => (
    <option key={kind} value={kind}>
      {kindLabel(kind)}
    </option>
  ))
  const whenOptions = (
    <>
      <option value={0}>{t('attachmentsView.anyTime', { defaultValue: 'Any time' })}</option>
      <option value={7}>{t('attachmentsView.lastWeek', { defaultValue: 'Last 7 days' })}</option>
      <option value={30}>{t('attachmentsView.lastMonth', { defaultValue: 'Last 30 days' })}</option>
      <option value={365}>{t('attachmentsView.lastYear', { defaultValue: 'Last year' })}</option>
    </>
  )
  const accountOptions = (
    <>
      <option value="">{t('attachmentsView.allAccounts', { defaultValue: 'All accounts' })}</option>
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.email}
        </option>
      ))}
    </>
  )
  const senderLabel = t('attachmentsView.sender', { defaultValue: 'From' })
  const typeLabel = t('attachmentsView.type', { defaultValue: 'Type' })
  const whenLabel = t('attachmentsView.when', { defaultValue: 'When' })
  const accountLabel = t('attachmentsView.account', { defaultValue: 'Account' })
  const setKind = (event: ChangeEvent<HTMLSelectElement>) =>
    attachmentList$.filter.kind.set(event.target.value as AttachmentKind)
  const setWithin = (event: ChangeEvent<HTMLSelectElement>) =>
    attachmentList$.filter.within.set(Number(event.target.value))
  const setAccount = (event: ChangeEvent<HTMLSelectElement>) => attachmentList$.filter.account.set(event.target.value)

  // Up to 1024 px the filters are the bar under the header, as before. The
  // file name is searched from the top band (ADR-0068 §2, #344).
  const filterBar = (
    <div
      // Below 1025 px the bar stands in for the pane: focus goes back here (#341).
      data-focus-return
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-header px-4 py-2"
    >
      <input
        value={filter.sender}
        data-focus-key="filter-sender"
        onChange={(event) => attachmentList$.filter.sender.set(event.target.value)}
        placeholder={senderLabel}
        aria-label={senderLabel}
        className="w-40 rounded-control border border-border bg-chats px-2.5 py-1.5 text-caption text-primary placeholder-secondary outline-none focus:border-accent-fg"
      />
      <select
        value={filter.kind}
        data-focus-key="filter-type"
        onChange={setKind}
        aria-label={typeLabel}
        className="rounded-control border border-border bg-chats px-2 py-1.5 text-caption text-primary"
      >
        {kindOptions}
      </select>
      <select
        value={filter.within}
        data-focus-key="filter-when"
        onChange={setWithin}
        aria-label={whenLabel}
        className="rounded-control border border-border bg-chats px-2 py-1.5 text-caption text-primary"
      >
        {whenOptions}
      </select>
      {accounts.length > 1 && (
        <select
          value={filter.account}
          data-focus-key="filter-account"
          onChange={setAccount}
          aria-label={accountLabel}
          className="rounded-control border border-border bg-chats px-2 py-1.5 text-caption text-primary"
        >
          {accountOptions}
        </select>
      )}
    </div>
  )

  // From 1025 px the same filters are the pane's body: one per row, each with
  // its visible label, which names the control as the bar's aria-label does.
  // `min-w-0` and `w-full` let a select with a long account address give way
  // to the pane instead of pushing the body sideways.
  const label = 'min-w-0 break-words text-caption font-semibold text-secondary'
  const field = 'w-full min-w-0 rounded-control border border-border bg-chats px-2.5 py-1.5 text-caption text-primary'
  const filterPane = (
    <FolderPane title={t('attachmentsView.filters', { defaultValue: 'Attachment filters' })}>
      <div className="flex min-w-0 flex-col gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${fieldId}-sender`} className={label}>
            {senderLabel}
          </label>
          <input
            id={`${fieldId}-sender`}
            data-focus-key="filter-sender"
            value={filter.sender}
            onChange={(event) => attachmentList$.filter.sender.set(event.target.value)}
            placeholder={senderLabel}
            className={clsx(field, 'placeholder-secondary outline-none focus:border-accent-fg')}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${fieldId}-type`} className={label}>
            {typeLabel}
          </label>
          <select
            id={`${fieldId}-type`}
            data-focus-key="filter-type"
            value={filter.kind}
            onChange={setKind}
            className={field}
          >
            {kindOptions}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${fieldId}-when`} className={label}>
            {whenLabel}
          </label>
          <select
            id={`${fieldId}-when`}
            data-focus-key="filter-when"
            value={filter.within}
            onChange={setWithin}
            className={field}
          >
            {whenOptions}
          </select>
        </div>
        {accounts.length > 1 && (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${fieldId}-account`} className={label}>
              {accountLabel}
            </label>
            <select
              id={`${fieldId}-account`}
              data-focus-key="filter-account"
              value={filter.account}
              onChange={setAccount}
              className={field}
            >
              {accountOptions}
            </select>
          </div>
        )}
      </div>
    </FolderPane>
  )

  // One tree in both modes: the list keeps its place among the content's
  // children, so crossing 1025 px does not remount it or lose its scroll
  // position. Only the filters move, into the pane or back to the bar.
  return (
    <>
      {inPane && filterPane}
      <div
        data-region="content"
        // Beside the pane the module asks for the list's minimum (360 px,
        // ADR-0068 §7) as its basis: the pane, whose shrink factor dwarfs
        // this one's, gives way first.
        className={clsx('flex min-h-0 min-w-0 flex-col bg-app', inPane ? 'flex-[1_1_360px]' : 'flex-1')}
      >
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
        {!inPane && filterBar}
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
                      <p dir="auto" className="truncate text-ui font-semibold text-primary">
                        {name}
                      </p>
                      <p className="truncate text-caption text-secondary">
                        {[
                          formatFileSize(item.size),
                          item.from_name || item.from_addr,
                          new Date(item.date * 1000).toLocaleDateString(intlLocale(), { dateStyle: 'medium' }),
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
                      <p className="w-full ps-8 text-2xs text-secondary">
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
    </>
  )
}
