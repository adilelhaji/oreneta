// Every attachment of the mail kept here, across accounts (#93, ADR-0020).
// Built from what each downloaded message says it carries; how much mail
// that covers is part of every answer.
import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { showToast } from './ui'

export type AttachmentKind =
  | ''
  | 'image'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'audio'
  | 'video'
  | 'calendar'
  | 'other'

export type ListedAttachment = {
  account: string
  folder: string
  uid: number
  thread_key: string
  thread_id: string
  subject: string
  from_name: string
  from_addr: string
  date: number
  index: number
  filename: string
  mime: string
  size: number
  key: string | null
  kind: Exclude<AttachmentKind, ''>
  unavailable: string
}

export type Coverage = { messages: number; downloaded: number }

export type AttachmentFilter = {
  account: string
  name: string
  sender: string
  kind: AttachmentKind
  /** Days back from now; 0 for any time. */
  within: number
}

export const PAGE_SIZE = 200

export const attachmentList$ = observable({
  filter: { account: '', name: '', sender: '', kind: '', within: 0 } as AttachmentFilter,
  items: [] as ListedAttachment[],
  total: 0,
  coverage: { messages: 0, downloaded: 0 } as Coverage,
  loading: false,
  loaded: false,
})

let request = 0

export async function loadAttachments(more = false) {
  const filter = attachmentList$.filter.peek()
  const mine = ++request
  attachmentList$.loading.set(true)
  try {
    const res = await invoke<{ items: ListedAttachment[]; total: number; coverage: Coverage }>('attachments.list', {
      account: filter.account,
      name: filter.name,
      sender: filter.sender,
      kind: filter.kind,
      from: filter.within > 0 ? Math.floor(Date.now() / 1000) - filter.within * 86400 : null,
      limit: PAGE_SIZE,
      offset: more ? attachmentList$.items.peek().length : 0,
    })
    // A slower answer to an older question does not overwrite a newer one.
    if (mine !== request) return
    attachmentList$.assign({
      items: more ? [...attachmentList$.items.peek(), ...res.items] : res.items,
      total: res.total,
      coverage: res.coverage,
      loaded: true,
    })
  } catch {
    if (mine === request)
      showToast(t('attachmentsView.couldNotLoad', { defaultValue: 'Could not list the attachments' }), 'error')
  } finally {
    if (mine === request) attachmentList$.loading.set(false)
  }
}

/** Mail whose attachments are not known here yet: its body was never downloaded. */
export function uncovered(coverage: Coverage): number {
  return Math.max(0, coverage.messages - coverage.downloaded)
}
