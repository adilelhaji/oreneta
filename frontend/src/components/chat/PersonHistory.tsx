import { useEffect, useState } from 'react'
import { CalendarDays, File, Loader2, MessageSquare } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { formatFileSize } from './messageHelpers'

export type PersonContext = {
  address: string
  conversations: { thread_id: string; folder: string; subject: string; date: number; from_them: boolean }[]
  events: { calendar_id: string; event_id: string; subject: string; start: number; end: number }[]
  files: { filename: string; size: number; thread_id: string; folder: string; date: number }[]
  coverage: { messages: number; downloaded: number }
}

/**
 * One person's history with the open account (#86): conversations, upcoming
 * meetings and files, each opening where it came from. Only this account,
 * and only what is kept here, which is said.
 */
export function PersonHistory({
  accountId,
  address,
  onOpenConversation,
  onOpenEvent,
}: {
  accountId: string
  address: string
  onOpenConversation: (threadId: string, folder: string) => void
  onOpenEvent: (start: number) => void
}) {
  const { t } = useTranslation()
  const [context, setContext] = useState<PersonContext | null>(null)
  const [failed, setFailed] = useState('')

  useEffect(() => {
    let current = true
    setContext(null)
    setFailed('')
    // An answer for another account or person never lands here.
    void invoke<PersonContext>('context.person', { account: accountId, address }).then(
      (answer) => current && setContext(answer),
      (error) => current && setFailed(error instanceof Error ? error.message : String(error)),
    )
    return () => {
      current = false
    }
  }, [accountId, address])

  if (failed) return <p className="p-4 text-caption text-danger">{failed}</p>
  if (!context)
    return (
      <div className="flex justify-center p-6">
        <Loader2
          size={18}
          className="animate-spin text-secondary"
          strokeWidth={1.75}
          aria-label={t('common.loading', { defaultValue: 'Loading' })}
        />
      </div>
    )

  const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString()
  const section = 'px-4 pt-3 pb-1 text-2xs font-semibold uppercase tracking-wide text-secondary'
  const row = 'flex w-full items-center gap-2 px-4 py-1.5 text-start text-caption hover:bg-hover cursor-pointer'
  const partial = context.coverage.downloaded < context.coverage.messages

  return (
    <div className="pb-3">
      <h4 className={section}>{t('person.conversations', { defaultValue: 'Conversations' })}</h4>
      {context.conversations.length === 0 ? (
        <p className="px-4 py-1 text-caption text-secondary">{t('person.none', { defaultValue: 'None kept here.' })}</p>
      ) : (
        <ul>
          {context.conversations.map((c) => (
            <li key={c.thread_id}>
              <button type="button" className={row} onClick={() => onOpenConversation(c.thread_id, c.folder)}>
                <MessageSquare size={14} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-primary">
                  {c.subject || t('chat.noSubject', { defaultValue: '(no subject)' })}
                </span>
                <span className="shrink-0 text-secondary">{day(c.date)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h4 className={section}>{t('person.meetings', { defaultValue: 'Upcoming meetings' })}</h4>
      {context.events.length === 0 ? (
        <p className="px-4 py-1 text-caption text-secondary">
          {t('person.noMeetings', { defaultValue: 'No meetings ahead with them.' })}
        </p>
      ) : (
        <ul>
          {context.events.map((e) => (
            <li key={`${e.calendar_id}:${e.event_id}`}>
              <button type="button" className={row} onClick={() => onOpenEvent(e.start)}>
                <CalendarDays size={14} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden="true" />
                <span dir="auto" className="min-w-0 flex-1 truncate text-primary">{e.subject}</span>
                <span className="shrink-0 text-secondary">{day(e.start)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h4 className={section}>{t('person.files', { defaultValue: 'Files from them' })}</h4>
      {context.files.length === 0 ? (
        <p className="px-4 py-1 text-caption text-secondary">
          {t('person.noFiles', { defaultValue: 'No files kept here.' })}
        </p>
      ) : (
        <ul>
          {context.files.map((f, index) => (
            <li key={`${f.thread_id}:${f.filename}:${index}`}>
              <button type="button" className={row} onClick={() => onOpenConversation(f.thread_id, f.folder)}>
                <File size={14} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden="true" />
                <span dir="auto" className="min-w-0 flex-1 truncate text-primary">{f.filename}</span>
                <span className="shrink-0 text-secondary">{formatFileSize(f.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="px-4 pt-3 text-2xs text-secondary">
        {partial
          ? t('person.partial', {
              downloaded: context.coverage.downloaded,
              messages: context.coverage.messages,
              defaultValue:
                'From the mail kept on this computer for this account: {downloaded} of {messages} messages are downloaded, so older history may be missing.',
            })
          : t('person.whole', {
              messages: context.coverage.messages,
              defaultValue: 'From the {messages} messages kept on this computer for this account.',
            })}
      </p>
    </div>
  )
}
