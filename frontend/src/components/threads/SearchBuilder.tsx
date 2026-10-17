import { useEffect, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { SEARCH_SCOPE_TEXT, searchScopeKind } from '../../lib/folderHiding'
import { UNIFIED_ACCOUNT, unifiedFolderLabel } from '../../lib/unifiedFolders'
import { folderPrefs$ } from '../../states/folderPrefs'
import { mail$ } from '../../states/mail'
import {
  EMPTY_QUERY,
  dayToSeconds,
  readQuery,
  secondsToDay,
  writeQuery,
  type SearchFlag,
  type SearchQuery,
} from '../../states/searchBuilder'
import { ui$ } from '../../states/ui'
import { Button } from '../button/Button'
import { Dialog } from '../dialog/Dialog'

const list = (text: string) =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

/**
 * The search box, field by field (#43). Opens on what is typed and writes
 * the result back into the box, through the core's own reading of it: what
 * is built here is exactly what typing it would search for.
 */
export function SearchBuilder({ query }: { query: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<SearchQuery>(EMPTY_QUERY)
  const [error, setError] = useState('')
  const accountId = useValue(ui$.selectedAccount)
  const folderId = useValue(ui$.selectedFolder)
  const folders = useValue(mail$.foldersByAccount[accountId]) ?? []
  const hidden = useValue(folderPrefs$.hidden)
  const scope = SEARCH_SCOPE_TEXT[searchScopeKind(accountId, folderId, folders, hidden)]
  const openFolder = folders.find((folder) => folder.id === folderId)
  const scopeFolder =
    accountId === UNIFIED_ACCOUNT
      ? unifiedFolderLabel(folderId, t)
      : openFolder?.role === 'inbox' || folderId.toLowerCase() === 'inbox'
        ? t('folders.roles.inbox', { defaultValue: 'Inbox' })
        : openFolder?.name || folderId

  useEffect(() => {
    if (!open) return
    setError('')
    void readQuery(query)
      .then(setDraft)
      .catch(() => setDraft(EMPTY_QUERY))
  }, [open, query])

  const has = (flag: SearchFlag) => draft.flags.includes(flag)
  const toggle = (flag: SearchFlag, on: boolean, exclusive: SearchFlag[] = []) =>
    setDraft((d) => ({
      ...d,
      flags: [...d.flags.filter((f) => f !== flag && !exclusive.includes(f)), ...(on ? [flag] : [])],
    }))
  const status = has('unread') ? 'unread' : has('read') ? 'read' : ''

  const apply = async () => {
    try {
      ui$.query.set(await writeQuery(draft))
      setOpen(false)
    } catch (err) {
      setError(String(err))
    }
  }

  const field = (id: string, label: string, value: string, onChange: (value: string) => void, hint?: string) => (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-caption font-semibold text-secondary">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={hint}
        className="rounded-control border border-border bg-app px-2.5 py-1.5 text-ui text-primary outline-none focus:border-accent"
      />
    </label>
  )

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('search.builder', { defaultValue: 'Search options' })}
        aria-label={t('search.builder', { defaultValue: 'Search options' })}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
      >
        <SlidersHorizontal size={16} strokeWidth={1.75} />
      </button>
      {open && (
        <Dialog
          title={t('search.builder', { defaultValue: 'Search options' })}
          icon={SlidersHorizontal}
          layer="raised"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(EMPTY_QUERY)}>
                {t('search.builderClear', { defaultValue: 'Clear' })}
              </Button>
              <Button onClick={() => void apply()}>{t('search.builderApply', { defaultValue: 'Search' })}</Button>
            </>
          }
        >
          {/* Where this search looks, and whether hidden folders are in it (#273). */}
          <p className="text-caption text-secondary">
            {t(scope.key, { folder: scopeFolder, defaultValue: scope.text })}
          </p>
          <div className="grid gap-3 min-[520px]:grid-cols-2">
            {field('sb-text', t('search.fieldWords', { defaultValue: 'Words' }), draft.text, (text) =>
              setDraft((d) => ({ ...d, text })),
            )}
            {field(
              'sb-from',
              t('search.fieldFrom', { defaultValue: 'From' }),
              draft.from.join(', '),
              (value) => setDraft((d) => ({ ...d, from: list(value) })),
              t('search.anyOf', { defaultValue: 'Any of, separated by commas' }),
            )}
            {field(
              'sb-to',
              t('search.fieldTo', { defaultValue: 'To' }),
              draft.to.join(', '),
              (value) => setDraft((d) => ({ ...d, to: list(value) })),
              t('search.anyOf', { defaultValue: 'Any of, separated by commas' }),
            )}
            {field(
              'sb-subject',
              t('search.fieldSubject', { defaultValue: 'Subject' }),
              draft.subject.join(', '),
              (value) => setDraft((d) => ({ ...d, subject: list(value) })),
            )}
            {field('sb-label', t('search.fieldLabel', { defaultValue: 'Label' }), draft.label ?? '', (value) =>
              setDraft((d) => ({ ...d, label: value.trim() || null })),
            )}
            <label htmlFor="sb-status" className="flex flex-col gap-1">
              <span className="text-caption font-semibold text-secondary">
                {t('search.fieldStatus', { defaultValue: 'Read or unread' })}
              </span>
              <select
                id="sb-status"
                value={status}
                onChange={(event) => {
                  const value = event.target.value as '' | 'unread' | 'read'
                  setDraft((d) => ({
                    ...d,
                    flags: [...d.flags.filter((f) => f !== 'unread' && f !== 'read'), ...(value ? [value] : [])],
                  }))
                }}
                className="rounded-control border border-border bg-app px-2 py-1.5 text-ui text-primary"
              >
                <option value="">{t('search.either', { defaultValue: 'Either' })}</option>
                <option value="unread">{t('search.unread', { defaultValue: 'Unread' })}</option>
                <option value="read">{t('search.read', { defaultValue: 'Read' })}</option>
              </select>
            </label>
            <label htmlFor="sb-after" className="flex flex-col gap-1">
              <span className="text-caption font-semibold text-secondary">
                {t('search.fieldAfter', { defaultValue: 'From day' })}
              </span>
              <input
                id="sb-after"
                type="date"
                value={secondsToDay(draft.after)}
                onChange={(event) => setDraft((d) => ({ ...d, after: dayToSeconds(event.target.value) }))}
                className="rounded-control border border-border bg-app px-2 py-1.5 text-ui text-primary"
              />
            </label>
            <label htmlFor="sb-before" className="flex flex-col gap-1">
              <span className="text-caption font-semibold text-secondary">
                {t('search.fieldBefore', { defaultValue: 'Before day' })}
              </span>
              <input
                id="sb-before"
                type="date"
                value={secondsToDay(draft.before)}
                onChange={(event) => setDraft((d) => ({ ...d, before: dayToSeconds(event.target.value) }))}
                className="rounded-control border border-border bg-app px-2 py-1.5 text-ui text-primary"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-ui text-primary">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={has('hasAttachment')}
                onChange={(e) => toggle('hasAttachment', e.target.checked)}
              />
              {t('search.hasAttachment', { defaultValue: 'Has attachments' })}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={has('starred')} onChange={(e) => toggle('starred', e.target.checked)} />
              {t('search.starred', { defaultValue: 'Starred' })}
            </label>
          </div>
          {error && (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </>
  )
}
