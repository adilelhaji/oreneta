import { useState } from 'react'
import { Server } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { addCalDavTaskList, discoverTaskCollections, type RemoteTaskCollection } from '../../states/tasks'
import { Button } from '../button/Button'
import { TextInput } from '../field/Field'
import { Dialog } from '../dialog/Dialog'

/**
 * Adds a task list kept on a CalDAV server (ADR-0039): the server and
 * sign-in first, then which of its collections, then the list's name here.
 * The list is read once before it is added; if that fails, nothing is kept
 * and the reason stays on screen.
 */
export function CalDavTaskListDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [found, setFound] = useState<RemoteTaskCollection[] | null>(null)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const changed = (set: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
    set(event.target.value)
    setFound(null)
  }

  const invalid = !server.trim() || (found !== null && (!url || !name.trim()))

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      if (found === null) {
        const collections = await discoverTaskCollections(server.trim(), username.trim(), password)
        setFound(collections)
        const first = collections.find((collection) => collection.writable !== false) ?? collections[0]
        setUrl(first?.url ?? '')
        setName(first?.name ?? '')
        return
      }
      await addCalDavTaskList({ url, name: name.trim(), server: server.trim(), username: username.trim(), password })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('tasks.caldavTitle', { defaultValue: 'Add a CalDAV task list' })}
      icon={Server}
      layer="raised"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={invalid || busy}>
            {found === null
              ? t('tasks.caldavFind', { defaultValue: 'Find lists' })
              : t('tasks.caldavAdd', { defaultValue: 'Add list' })}
          </Button>
        </>
      }
    >
      <p className="px-0.5 text-caption text-secondary">
        {t('tasks.caldavHint', {
          defaultValue:
            'Tasks on a CalDAV server (Nextcloud, Fastmail, Radicale…), synced both ways. The password is kept in the system keychain. Repeating tasks are shown but not edited here.',
        })}
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!invalid && !busy) void submit()
        }}
      >
        <Labelled label={t('calendar.server', { defaultValue: 'Server or address' })}>
          <TextInput
            value={server}
            onChange={changed(setServer)}
            placeholder="caldav.example.com"
            autoFocus
            fieldSize="md"
            surface="raised"
            className="w-full"
          />
        </Labelled>
        <Labelled label={t('calendar.username', { defaultValue: 'User name' })}>
          <TextInput
            value={username}
            onChange={changed(setUsername)}
            autoComplete="username"
            fieldSize="md"
            surface="raised"
            className="w-full"
          />
        </Labelled>
        <Labelled label={t('calendar.password', { defaultValue: 'Password' })}>
          <TextInput
            type="password"
            value={password}
            onChange={changed(setPassword)}
            autoComplete="current-password"
            fieldSize="md"
            surface="raised"
            className="w-full"
          />
        </Labelled>
        {found !== null && (
          <>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 ps-0.5 text-caption font-semibold text-secondary">
                {t('tasks.caldavFound', { defaultValue: 'Collections on this server' })}
              </legend>
              {found.length === 0 && (
                <p className="text-caption text-secondary">
                  {t('tasks.caldavNone', { defaultValue: 'This server offers no collections to this user.' })}
                </p>
              )}
              {found.map((collection) => (
                <label key={collection.url} className="flex items-center gap-2 text-caption text-primary">
                  <input
                    type="radio"
                    name="collection"
                    checked={url === collection.url}
                    onChange={() => {
                      setUrl(collection.url)
                      setName(collection.name)
                    }}
                  />
                  <span>{collection.name}</span>
                  {collection.writable === false && (
                    <span className="text-2xs text-secondary">
                      {t('calendar.readOnly', { defaultValue: 'read-only' })}
                    </span>
                  )}
                </label>
              ))}
            </fieldset>
            <Labelled label={t('tasks.caldavName', { defaultValue: 'Name here' })}>
              <TextInput
                value={name}
                onChange={(event) => setName(event.target.value)}
                fieldSize="md"
                surface="raised"
                className="w-full"
              />
            </Labelled>
          </>
        )}
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex w-full flex-col gap-1.5">
      <span className="ps-0.5 text-caption font-semibold text-secondary">{label}</span>
      {children}
    </label>
  )
}
