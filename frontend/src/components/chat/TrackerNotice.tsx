import { useState } from 'react'
import { ShieldCheck, ShieldOff } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { confirmAction, showToast } from '../../states/ui'
import { loadThread } from '../../states/mail'
import type { Message } from '../../types'

const hostOf = (url: string) => {
  try {
    return new URL(url.startsWith('//') ? `https:${url}` : url).host
  } catch {
    return url
  }
}

/**
 * What tracking protection did for this message (#107, ADR-0029): how many
 * addresses it kept the message from fetching, by which rule, and a way to
 * let this one message load them, said plainly and asked first.
 */
export function TrackerNotice({ message }: { message: Message }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const blocked = message.trackers_blocked ?? []
  const allowed = message.trackers_protected === false

  if (!allowed && blocked.length === 0) return null

  const change = async (allow: boolean) => {
    if (allow) {
      const ok = await confirmAction({
        title: t('trackers.allowTitle', { defaultValue: 'Let this message load its trackers?' }),
        message: t('trackers.allowMessage', {
          defaultValue:
            'The sender will be able to tell you opened it, and when. This applies to this message only; remote images still follow the account’s setting.',
        }),
        confirmLabel: t('trackers.allowConfirm', { defaultValue: 'Load them' }),
        cancelLabel: t('buttons.cancel'),
      })
      if (!ok) return
    }
    try {
      await invoke('privacy.allowMessage', { account: message.account_id, message_id: message.message_id, allow })
      await loadThread(message.thread_id)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  if (allowed) {
    return (
      <p className="mb-2 flex flex-wrap items-center gap-1.5 text-caption text-secondary">
        <ShieldOff size={14} strokeWidth={1.75} aria-hidden="true" />
        {t('trackers.allowed', { defaultValue: 'Trackers are allowed in this message.' })}
        <button type="button" onClick={() => void change(false)} className="text-accent underline cursor-pointer">
          {t('trackers.blockAgain', { defaultValue: 'Block them again' })}
        </button>
      </p>
    )
  }

  return (
    <div className="mb-2 text-caption text-secondary">
      <p className="flex flex-wrap items-center gap-1.5">
        <ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" className="text-accent" />
        {t('trackers.blocked', {
          count: blocked.length,
          defaultValue: '{count, plural, one {# tracker} other {# trackers}} blocked',
        })}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className="text-accent underline cursor-pointer"
        >
          {open ? t('trackers.hide', { defaultValue: 'Hide' }) : t('trackers.which', { defaultValue: 'Which' })}
        </button>
        {message.message_id && (
          <button type="button" onClick={() => void change(true)} className="text-accent underline cursor-pointer">
            {t('trackers.allow', { defaultValue: 'Load them for this message' })}
          </button>
        )}
      </p>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5 ps-5">
          {blocked.map((entry, index) => (
            <li key={index} className="break-all">
              {hostOf(entry.url)} —{' '}
              {t('trackers.byRule', { rule: entry.rule, defaultValue: 'EasyPrivacy rule {rule}' })}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
