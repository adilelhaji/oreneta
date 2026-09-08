import type { Account, Folder, Message } from '../src/types'
import type { Task } from '../src/states/tasks'

export const FIXED_NOW = '2026-09-08T12:00:00.000Z'
export const SCENES = ['inbox', 'reader', 'composer', 'tasks'] as const
export type Scene = (typeof SCENES)[number]

export function scenario(params: URLSearchParams) {
  const scene = params.get('scene') ?? 'inbox'
  const theme = params.get('theme') ?? 'light'
  if (!SCENES.includes(scene as Scene)) throw new Error('Unknown baseline scene')
  if (theme !== 'light' && theme !== 'dark') throw new Error('Unknown baseline theme')
  return { scene: scene as Scene, theme }
}

export function createFixture() {
  const account: Account = {
    id: 'synthetic-account',
    email: 'alex@example.test',
    display_name: 'Alex · Demo',
    provider: 'imap',
    auth_type: 'password',
    imap_host: 'imap.example.test',
    imap_port: 993,
    smtp_host: 'smtp.example.test',
    smtp_port: 465,
    tls: true,
    paused: true,
    conversation_html: false,
    load_remote_images: false,
  }
  const folders: Folder[] = [
    { id: 'INBOX', account_id: account.id, name: 'Inbox', role: 'inbox', unread: 3 },
    { id: 'Sent', account_id: account.id, name: 'Sent', role: 'sent', unread: 0 },
    { id: 'Drafts', account_id: account.id, name: 'Drafts', role: 'drafts', unread: 0 },
  ]
  const subjects = [
    'Pilot checklist — synthetic conversation',
    'A deliberately long subject about delivery, accessibility and customer follow-up across teams',
    'Budget review: Q4 planning',
    'Meeting notes and next steps',
    'Invoice with an attachment',
    'Welcome to the internal demo',
  ]
  const threads: Message[] = subjects.map((subject, i) => ({
    id: `message-${i + 1}`,
    account_id: account.id,
    folder_id: 'INBOX',
    thread_id: `thread-${i + 1}`,
    from_name:
      i === 1 ? 'Morgan Alexandra Rivera · Customer Success and Operations' : 'Morgan Rivera',
    from_addr: 'morgan@example.test',
    to: account.email,
    subject,
    preview: 'Synthetic mail for repeatable visual review. No external delivery.',
    body: 'Hello Alex,\n\nPlease review the pilot checklist and the follow-up task.\nThis is synthetic content; no message was sent.\n\nThanks,\nMorgan',
    date: Date.parse(FIXED_NOW) / 1000 - i * 3600,
    unread: i < 3,
    starred: i === 0,
    has_attachments: i === 4,
    labels: i < 2 ? ['work', 'review'] : [],
  }))
  const messages: Message[] = [
    threads[0],
    {
      ...threads[0],
      id: 'reply-1',
      from_name: 'Alex',
      from_addr: account.email,
      to: 'morgan@example.test',
      body: 'Thanks Morgan. I will review the checklist today.',
      outgoing: true,
      unread: false,
      date: threads[0].date + 60,
    },
  ]
  const tasks: Task[] = [
    {
      id: 1,
      thread_id: threads[0].thread_id,
      account_id: account.id,
      folder_id: 'INBOX',
      note: 'Review the synthetic pilot checklist',
      due_at: Date.parse(FIXED_NOW) / 1000,
      completed_at: null,
      created_at: Date.parse(FIXED_NOW) / 1000 - 86400,
      subject: threads[0].subject,
      from_name: threads[0].from_name,
      from_addr: threads[0].from_addr,
    },
  ]
  return { account, folders, threads, messages, tasks }
}

export type BaselineFixture = ReturnType<typeof createFixture>
