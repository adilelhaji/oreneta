import { useEffect, useState } from 'react'
import { Users } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { contactSources$, groupBooks, loadContactSources } from '../../states/contactSources'
import { people$, saveGroup } from '../../states/people'
import { Dialog } from '../dialog/Dialog'
import { Button } from '../button/Button'
import { TextInput } from '../field/Field'

const labelClass = 'text-caption font-bold uppercase tracking-wide text-secondary'

/**
 * Names a new contact group or renames one (ADR-0052). A new group is kept on
 * this computer, in a CardDAV book or as an Exchange account's distribution
 * list (ADR-0058); one on a server is seen by every app that reads the book,
 * and can only hold that book's people.
 */
export function GroupDialog() {
  const { t } = useTranslation()
  const editing = useValue(people$.groupEditing)
  const sources = useValue(contactSources$.sources)
  const sourcesLoaded = useValue(contactSources$.loaded)
  const [busy, setBusy] = useState(false)
  const open = Boolean(editing)
  useEffect(() => {
    if (open && !sourcesLoaded) void loadContactSources()
  }, [open, sourcesLoaded])
  if (!editing) return null
  const books = groupBooks(sources)
  const close = () => people$.groupEditing.set(null)
  const submit = async () => {
    if (!editing.name.trim()) return
    setBusy(true)
    try {
      if (await saveGroup(editing)) close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={
        editing.id
          ? t('people.renameGroup', { defaultValue: 'Rename group' })
          : t('people.newGroup', { defaultValue: 'New group' })
      }
      icon={Users}
      width="sm"
      onClose={close}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy || !editing.name.trim()}>
            {busy ? t('common.loading') : t('buttons.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>{t('people.groupName', { defaultValue: 'Group name' })}</span>
          <TextInput
            value={editing.name}
            onChange={(e) => people$.groupEditing.set({ ...editing, name: e.target.value })}
            autoFocus
          />
        </label>
        {!editing.id && books.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>{t('people.saveTo', { defaultValue: 'Save to' })}</span>
            <select
              value={editing.book}
              onChange={(e) => people$.groupEditing.set({ ...editing, book: e.target.value, members: [] })}
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
      </form>
    </Dialog>
  )
}
