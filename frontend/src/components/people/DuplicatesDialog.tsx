import { useState } from 'react'
import { Users } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { linkPeople, notTheSame, people$, sourceLabel } from '../../states/people'
import { Dialog } from '../dialog/Dialog'
import { Button } from '../button/Button'

/**
 * People who share an address, for the reader to link as one or to mark as
 * different (ADR-0012). Linking only changes how they are shown here: nothing
 * is merged or deleted, on this computer or on any server.
 */
export function DuplicatesDialog() {
  const { t } = useTranslation()
  const open = useValue(people$.duplicatesOpen)
  const groups = useValue(people$.duplicates)
  const [busy, setBusy] = useState(false)
  if (!open) return null
  const close = () => people$.duplicatesOpen.set(false)
  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    await action()
    setBusy(false)
  }

  return (
    <Dialog
      title={t('people.duplicatesTitle', { defaultValue: 'Possible duplicates' })}
      subtitle={t('people.duplicatesText', {
        defaultValue:
          'Linking shows them as one person. Nothing is deleted, here or on any server, and it can be undone.',
      })}
      icon={Users}
      width="lg"
      onClose={close}
      closeDisabled={busy}
      footer={
        <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
          {t('buttons.close', { defaultValue: 'Close' })}
        </Button>
      }
    >
      {groups.length === 0 ? (
        <p className="text-ui text-secondary">
          {t('people.noDuplicates', { defaultValue: 'No possible duplicates left.' })}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) => {
            const ids = group.map((person) => person.id)
            return (
              <li key={ids.join('|')} className="rounded-control border border-border bg-chats p-3">
                <ul className="flex flex-col gap-1">
                  {group.map((person) => (
                    <li key={person.id} className="wrap-anywhere text-ui text-primary">
                      {person.name || person.emails[0]?.addr}
                      <span className="text-caption text-secondary">
                        {' · '}
                        {t(`people.source.${sourceLabel(person.source)}`)}
                        {person.emails[0] && ` · ${person.emails[0].addr}`}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void act(() => linkPeople(ids))}>
                    {t('people.linkAsOne', { defaultValue: 'Same person: link' })}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => notTheSame(ids))}>
                    {t('people.notTheSame', { defaultValue: 'Not the same' })}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
