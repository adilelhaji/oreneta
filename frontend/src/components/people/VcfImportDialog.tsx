import { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { contactSources$, loadContactSources, writableBooks } from '../../states/contactSources'
import { confirmVcfImport, people$ } from '../../states/people'
import { Dialog } from '../dialog/Dialog'
import { Button } from '../button/Button'

/** What a .vcf holds, and where to put it, before anything is stored (ADR-0012). */
export function VcfImportDialog() {
  const { t } = useTranslation()
  const pending = useValue(people$.importing)
  const sources = useValue(contactSources$.sources)
  const loaded = useValue(contactSources$.loaded)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (pending && !loaded) void loadContactSources()
  }, [Boolean(pending), loaded])
  if (!pending) return null
  // A file goes to the local book or a CardDAV one; importing into an
  // Exchange folder is not offered (ADR-0064).
  const books = writableBooks(sources).filter((book) => book.kind === 'carddav')
  const close = () => people$.importing.set(null)
  const shown = pending.people.slice(0, 8)

  return (
    <Dialog
      title={t('people.importTitle', { defaultValue: 'Import contacts' })}
      icon={Upload}
      width="md"
      onClose={close}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || pending.people.length === 0}
            onClick={async () => {
              setBusy(true)
              await confirmVcfImport(pending)
              setBusy(false)
            }}
          >
            {busy
              ? t('common.loading')
              : t('people.importCount', {
                  count: pending.people.length,
                  defaultValue: '{count, plural, one {Import # contact} other {Import # contacts}}',
                })}
          </Button>
        </>
      }
    >
      <p className="text-ui text-secondary">
        {t('people.importSummary', {
          count: pending.people.length,
          skipped: pending.skipped,
          defaultValue:
            '{count, plural, one {# contact} other {# contacts}} in this file{skipped, plural, =0 {} one {; # card has no name or address and will be left out} other {; # cards have no name or address and will be left out}}. People already in the book are not added twice.',
        })}
      </p>
      <ul className="mt-3 flex flex-col gap-1 rounded-control border border-border bg-chats p-3 text-ui text-primary">
        {shown.map((person, index) => (
          <li key={index} className="wrap-anywhere">
            {person.name || person.emails[0]?.addr}
            {person.emails[0] && person.name && <span className="text-secondary"> · {person.emails[0].addr}</span>}
          </li>
        ))}
        {pending.people.length > shown.length && (
          <li className="text-secondary">
            {t('people.andMore', { count: pending.people.length - shown.length, defaultValue: 'and {count} more' })}
          </li>
        )}
      </ul>
      {books.length > 0 && (
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-caption font-bold uppercase tracking-wide text-secondary">
            {t('people.saveTo', { defaultValue: 'Save to' })}
          </span>
          <select
            value={pending.book}
            onChange={(e) => people$.importing.set({ ...pending, book: e.target.value })}
            className="w-full rounded-control-sm border border-border bg-app px-3 py-2 text-sm text-primary outline-none focus:border-accent"
          >
            <option value="">{t('people.thisComputer', { defaultValue: 'This computer' })}</option>
            {books.map((book) => (
              <option key={book.id} value={book.id}>
                {book.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </Dialog>
  )
}
