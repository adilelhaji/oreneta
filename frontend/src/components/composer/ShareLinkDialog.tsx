import { useEffect, useRef, useState } from 'react'
import { Cloud } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import {
  cancelCloudUpload,
  checkCloud,
  cloudAccounts$,
  cloudErrorText,
  cloudUploads$,
  createCloudLink,
  expiryDate,
  linkPassword,
  pickCloudFile,
  refreshCloud,
  revokeCloudLink,
  uploadToCloud,
  type CloudCapabilities,
  type CloudLink,
  type PickedFile,
} from '../../states/cloud'
import { formatFileSize } from '../chat/messageHelpers'
import { Dialog } from '../dialog/Dialog'
import { Button } from '../button/Button'

/**
 * Sharing a file by link (#108, ADR-0033): where it goes, what the link will
 * allow and until when, then the upload with its progress, and the link the
 * server actually made, before anything goes into the message.
 */
export function ShareLinkDialog({
  onInsert,
  onClose,
}: {
  onInsert: (link: CloudLink, name: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const accounts = useValue(cloudAccounts$)
  const [accountId, setAccountId] = useState('')
  const [caps, setCaps] = useState<CloudCapabilities | null>(null)
  const [file, setFile] = useState<PickedFile | null>(null)
  const [usePassword, setUsePassword] = useState(true)
  const [password, setPassword] = useState(() => linkPassword())
  const [days, setDays] = useState(7)
  const [expire, setExpire] = useState(true)
  const [phase, setPhase] = useState<'choose' | 'uploading' | 'linking' | 'done'>('choose')
  const [problem, setProblem] = useState('')
  const [link, setLink] = useState<CloudLink | null>(null)
  const uploadId = useRef('')
  const progress = useValue(() => (uploadId.current ? cloudUploads$[uploadId.current].get() : undefined))
  const account = accounts.find((a) => a.id === accountId)

  useEffect(() => {
    void refreshCloud().catch(() => {})
  }, [])
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id)
  }, [accounts, accountId])
  useEffect(() => {
    if (!accountId) return
    setCaps(null)
    setProblem('')
    void checkCloud(accountId).then((answer) => {
      if (answer.capabilities) {
        const c = answer.capabilities
        setCaps(c)
        if (c.password_enforced) setUsePassword(true)
        if (c.expiry_enforced) setExpire(true)
        if (c.expiry_max_days) setDays((d) => Math.min(d, c.expiry_max_days!))
      } else setProblem(cloudErrorText(answer.error, t))
    })
  }, [accountId, t])

  const start = async () => {
    if (!account || !file) return
    setProblem('')
    uploadId.current = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setPhase('uploading')
    const uploaded = await uploadToCloud(account.id, file, uploadId.current)
    if (!uploaded.path) {
      setPhase('choose')
      setProblem(cloudErrorText(uploaded.error, t))
      return
    }
    setPhase('linking')
    const made = await createCloudLink(account.id, uploaded.path, {
      ...(usePassword ? { password } : {}),
      ...(expire ? { expires: expiryDate(days) } : {}),
    })
    if (!made.link) {
      setPhase('choose')
      setProblem(cloudErrorText(made.error, t))
      return
    }
    setLink(made.link)
    setPhase('done')
  }

  const withdraw = async () => {
    if (account && link) await revokeCloudLink(account.id, link.id).catch(() => {})
    onClose()
  }

  const footer =
    phase === 'done' && link ? (
      <>
        <Button variant="secondary" onClick={() => void withdraw()}>
          {t('cloud.withdraw', { defaultValue: 'Withdraw the link' })}
        </Button>
        <Button onClick={() => onInsert(link, file?.name ?? '')}>
          {t('cloud.insert', { defaultValue: 'Insert the link' })}
        </Button>
      </>
    ) : phase === 'uploading' ? (
      <Button variant="secondary" onClick={() => void cancelCloudUpload(uploadId.current)}>
        {t('buttons.cancel')}
      </Button>
    ) : (
      <>
        <Button variant="secondary" onClick={onClose}>
          {t('buttons.cancel')}
        </Button>
        <Button
          disabled={!account || !file || !caps?.links || phase !== 'choose' || (usePassword && !password)}
          onClick={() => void start()}
        >
          {t('cloud.upload', { defaultValue: 'Upload and create the link' })}
        </Button>
      </>
    )

  return (
    <Dialog
      title={t('cloud.title', { defaultValue: 'Share a file by link' })}
      icon={Cloud}
      width="lg"
      onClose={phase === 'done' ? onClose : phase === 'choose' ? onClose : () => {}}
      closeDisabled={phase === 'uploading' || phase === 'linking'}
      footer={footer}
    >
      <div className="flex flex-col gap-3 text-caption">
        {accounts.length === 0 ? (
          <p className="text-secondary">
            {t('cloud.none', {
              defaultValue: 'Add a Nextcloud or ownCloud storage in Settings → Cloud storage first.',
            })}
          </p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-secondary">
              {t('cloud.storage', { defaultValue: 'Storage' })}
              <select
                value={accountId}
                disabled={phase !== 'choose'}
                onChange={(e) => setAccountId(e.target.value)}
                className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || a.server}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={phase !== 'choose'}
                onClick={() => void pickCloudFile().then((f) => f && setFile(f))}
              >
                {t('cloud.pick', { defaultValue: 'Choose a file' })}
              </Button>
              {file && (
                <span className="text-primary">
                  {file.name} · {formatFileSize(file.size)}
                </span>
              )}
            </div>
            {account && file && (
              <p className="text-secondary">
                {t('cloud.destination', {
                  name: file.name,
                  folder: account.folder,
                  server: account.server,
                  defaultValue: 'Goes to {folder}/{name} on {server}. A name already taken there gets a number.',
                })}
              </p>
            )}
            {caps && !caps.links && (
              <p role="alert" className="text-danger">
                {t('cloud.noLinks', { defaultValue: 'This server does not allow links.' })}
              </p>
            )}
            {caps?.links && (
              <fieldset className="flex flex-col gap-2" disabled={phase !== 'choose'}>
                <legend className="mb-1 text-secondary">
                  {t('cloud.linkLegend', {
                    defaultValue: 'The link lets anyone who has it view the file, not change it.',
                  })}
                </legend>
                <label className="flex flex-wrap items-center gap-2 text-secondary">
                  <input
                    type="checkbox"
                    checked={usePassword}
                    disabled={caps.password_enforced}
                    onChange={(e) => setUsePassword(e.target.checked)}
                    className="accent-accent"
                  />
                  {t('cloud.password', { defaultValue: 'Password' })}
                  {usePassword && (
                    <input
                      aria-label={t('cloud.password', { defaultValue: 'Password' })}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="rounded-control-sm border border-border bg-app px-2 py-1 font-mono text-caption text-primary"
                    />
                  )}
                  {caps.password_enforced && (
                    <span>{t('cloud.required', { defaultValue: '(the server requires it)' })}</span>
                  )}
                </label>
                <label className="flex flex-wrap items-center gap-2 text-secondary">
                  <input
                    type="checkbox"
                    checked={expire}
                    disabled={caps.expiry_enforced}
                    onChange={(e) => setExpire(e.target.checked)}
                    className="accent-accent"
                  />
                  {t('cloud.expires', { defaultValue: 'Stops working after' })}
                  <input
                    type="number"
                    aria-label={t('cloud.days', { defaultValue: 'Days' })}
                    min={1}
                    max={caps.expiry_max_days ?? 365}
                    value={days}
                    disabled={!expire}
                    onChange={(e) =>
                      setDays(Math.max(1, Math.min(caps.expiry_max_days ?? 365, Number(e.target.value) || 1)))
                    }
                    className="w-16 rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
                  />
                  {t('cloud.daysLabel', { date: expiryDate(days), defaultValue: 'days ({date})' })}
                </label>
              </fieldset>
            )}
          </>
        )}
        {phase === 'uploading' && (
          <div role="status" className="flex items-center gap-2 text-secondary">
            <progress
              aria-label={t('cloud.uploading', { defaultValue: 'Uploading' })}
              value={progress?.done ?? 0}
              max={progress?.total || file?.size || 1}
              className="w-40"
            />
            {formatFileSize(progress?.done ?? 0)} / {formatFileSize(file?.size ?? 0)}
          </div>
        )}
        {phase === 'linking' && (
          <p role="status" className="text-secondary">
            {t('cloud.linking', { defaultValue: 'Creating the link…' })}
          </p>
        )}
        {problem && (
          <p role="alert" className="text-danger">
            {problem}
          </p>
        )}
        {phase === 'done' && link && (
          <section aria-label={t('cloud.made', { defaultValue: 'The link' })} className="flex flex-col gap-1">
            <code className="break-all rounded-control-sm bg-app px-2 py-1 text-primary">{link.url}</code>
            <p className="text-secondary">
              {[
                t('cloud.viewOnly', { defaultValue: 'View only' }),
                link.expires
                  ? t('cloud.until', { date: link.expires, defaultValue: 'works until {date}' })
                  : t('cloud.noExpiry', { defaultValue: 'does not expire' }),
                link.password_protected
                  ? t('cloud.protected', { defaultValue: 'needs the password' })
                  : t('cloud.open', { defaultValue: 'no password' }),
              ].join(' · ')}
            </p>
            {link.password_protected && (
              <p className="text-secondary">
                {t('cloud.passwordApart', {
                  defaultValue: 'The password is not put in the message: send it another way.',
                })}
              </p>
            )}
          </section>
        )}
      </div>
    </Dialog>
  )
}
