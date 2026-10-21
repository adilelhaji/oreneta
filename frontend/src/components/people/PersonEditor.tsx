import { useEffect, useState } from 'react'
import { Plus, UserPen, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { contactSources$, loadContactSources, writableBooks } from '../../states/contactSources'
import { keepMine, keepSaved, people$, savePerson, type PersonDraft } from '../../states/people'
import { Dialog } from '../dialog/Dialog'
import { Button } from '../button/Button'
import { IconButton } from '../button/IconButton'
import { TextInput } from '../field/Field'

const labelClass = 'text-caption font-bold uppercase tracking-wide text-secondary'

/**
 * Writes a person in the local book (ADR-0012).
 *
 * Saving names the version the editor opened on. If the person changed in
 * another window meanwhile, nothing is saved: the editor shows both copies
 * and the reader keeps one of them. Neither is ever merged or overwritten
 * without being seen.
 */
export function PersonEditor() {
  const { t } = useTranslation()
  const editing = useValue(people$.editing)
  const sources = useValue(contactSources$.sources)
  const sourcesLoaded = useValue(contactSources$.loaded)
  const [busy, setBusy] = useState(false)
  const open = Boolean(editing)
  useEffect(() => {
    if (open && !sourcesLoaded) void loadContactSources()
  }, [open, sourcesLoaded])
  if (!editing) return null
  const books = writableBooks(sources)
  // Where this person is, or will be, kept: said plainly, because a change to
  // a server book is seen by every app that reads it.
  const bookName = (id?: string) => sources.find((source) => source.id === id)?.name
  const where = editing.id
    ? editing.serverBook
      ? t('people.savedOnServer', {
          name: bookName(editing.serverBook) ?? '',
          defaultValue: 'Saved in {name}, on its server.',
        })
      : t('people.localOnly', { defaultValue: 'Kept on this computer only.' })
    : editing.book
      ? t('people.savedOnServer', {
          name: bookName(editing.book) ?? '',
          defaultValue: 'Saved in {name}, on its server.',
        })
      : t('people.localOnly', { defaultValue: 'Kept on this computer only.' })

  const draft = editing.draft
  const set = (patch: Partial<PersonDraft>) => people$.editing.set({ ...editing, draft: { ...draft, ...patch } })
  const close = () => people$.editing.set(null)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  if (editing.conflict) {
    const current = editing.conflict.current
    return (
      <Dialog
        title={t('people.conflictTitle', { defaultValue: 'Changed in another window' })}
        icon={UserPen}
        role="alertdialog"
        width="lg"
        onClose={close}
        closeDisabled={busy}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => void run(keepSaved)} disabled={busy}>
              {current
                ? t('people.keepSaved', { defaultValue: 'Keep the saved copy' })
                : t('people.discardMine', { defaultValue: 'Discard my changes' })}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void run(() => keepMine(editing))} disabled={busy}>
              {current
                ? t('people.keepMine', { defaultValue: 'Keep mine' })
                : t('people.createAgain', { defaultValue: 'Create it again' })}
            </Button>
          </>
        }
      >
        <p className="text-ui text-secondary">
          {current
            ? t('people.conflictText', {
                defaultValue: 'Nothing was saved. Choose which copy to keep; the other is discarded.',
              })
            : t('people.deletedText', {
                defaultValue: 'This contact was deleted in another window. Nothing was saved.',
              })}
        </p>
        <div className="mt-4 grid gap-3 min-[600px]:grid-cols-2">
          <DraftSummary title={t('people.yours', { defaultValue: 'Yours' })} draft={draft} />
          {current && <DraftSummary title={t('people.savedCopy', { defaultValue: 'Saved' })} draft={current} />}
        </div>
      </Dialog>
    )
  }

  const updateRow = <K extends 'emails' | 'phones'>(key: K, index: number, patch: Partial<PersonDraft[K][number]>) =>
    set({ [key]: draft[key].map((row, i) => (i === index ? { ...row, ...patch } : row)) } as Partial<PersonDraft>)
  const removeRow = (key: 'emails' | 'phones', index: number) =>
    set({ [key]: draft[key].filter((_, i) => i !== index) } as Partial<PersonDraft>)

  const submit = () => void run(() => savePerson(editing))

  return (
    <Dialog
      title={
        editing.id
          ? t('people.editTitle', { defaultValue: 'Edit contact' })
          : t('people.newTitle', { defaultValue: 'New contact' })
      }
      subtitle={where}
      icon={UserPen}
      width="md"
      onClose={close}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
            {busy ? t('common.loading') : t('buttons.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {!editing.id && books.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>{t('people.saveTo', { defaultValue: 'Save to' })}</span>
            <select
              value={editing.book ?? ''}
              onChange={(e) => people$.editing.set({ ...editing, book: e.target.value || undefined })}
              className="w-full rounded-control-sm border border-border bg-app px-3 py-2 text-sm text-primary outline-none focus:border-accent-fg"
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
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>{t('people.name', { defaultValue: 'Name' })}</span>
          <TextInput value={draft.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
        </label>
        {/* The parts, kept apart so lists can order names as the reader
            chose (ADR-0052). Optional: a name with no parts is shown as
            written, never split by guessing. */}
        <div className="grid gap-3 min-[480px]:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>{t('people.givenName', { defaultValue: 'First name' })}</span>
            <TextInput value={draft.given} onChange={(e) => set({ given: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>{t('people.familyName', { defaultValue: 'Last name' })}</span>
            <TextInput value={draft.family} onChange={(e) => set({ family: e.target.value })} />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>{t('people.organisationField', { defaultValue: 'Organisation' })}</span>
          <TextInput value={draft.organisation} onChange={(e) => set({ organisation: e.target.value })} />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className={labelClass}>{t('people.emails')}</legend>
          {draft.emails.map((email, index) => (
            <div key={index} className="flex items-center gap-2">
              <TextInput
                type="email"
                value={email.addr}
                aria-label={t('people.emailN', { n: index + 1, defaultValue: 'Email {n}' })}
                onChange={(e) => updateRow('emails', index, { addr: e.target.value })}
                className="min-w-0 flex-1"
              />
              <IconButton
                icon={X}
                iconSize={14}
                size="sm"
                label={t('people.removeEmail', { defaultValue: 'Remove this email' })}
                onClick={() => removeRow('emails', index)}
              />
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="self-start"
            onClick={() => set({ emails: [...draft.emails, { addr: '', label: '' }] })}
          >
            <Plus size={14} strokeWidth={1.75} />
            {t('people.addEmail', { defaultValue: 'Add email' })}
          </Button>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className={labelClass}>{t('people.phones')}</legend>
          {draft.phones.map((phone, index) => (
            <div key={index} className="flex items-center gap-2">
              <TextInput
                type="tel"
                value={phone.number}
                aria-label={t('people.phoneN', { n: index + 1, defaultValue: 'Phone {n}' })}
                onChange={(e) => updateRow('phones', index, { number: e.target.value })}
                className="min-w-0 flex-1"
              />
              <IconButton
                icon={X}
                iconSize={14}
                size="sm"
                label={t('people.removePhone', { defaultValue: 'Remove this phone' })}
                onClick={() => removeRow('phones', index)}
              />
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="self-start"
            onClick={() => set({ phones: [...draft.phones, { number: '', label: '' }] })}
          >
            <Plus size={14} strokeWidth={1.75} />
            {t('people.addPhone', { defaultValue: 'Add phone' })}
          </Button>
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>{t('people.note')}</span>
          <textarea
            rows={3}
            value={draft.note}
            onChange={(e) => set({ note: e.target.value })}
            className="w-full resize-y rounded-control-sm border border-border bg-app px-3 py-2 text-sm text-primary outline-none focus:border-accent-fg"
          />
        </label>
      </form>
    </Dialog>
  )
}

function DraftSummary({ title, draft }: { title: string; draft: PersonDraft }) {
  const lines = [
    draft.name,
    draft.organisation,
    ...draft.emails.map((email) => email.addr),
    ...draft.phones.map((phone) => phone.number),
    draft.note,
  ].filter((line) => line.trim())
  return (
    <section className="rounded-control border border-border bg-chats p-3">
      <h3 className={labelClass}>{title}</h3>
      <ul className="mt-2 flex flex-col gap-1 text-ui text-primary">
        {lines.map((line, index) => (
          <li key={index} className="wrap-anywhere">
            {line}
          </li>
        ))}
      </ul>
    </section>
  )
}
