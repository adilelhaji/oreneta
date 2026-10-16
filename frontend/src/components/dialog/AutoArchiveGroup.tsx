import { useCallback, useEffect, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { showToast } from '../../states/ui'
import {
  autoArchiveRan$,
  loadAutoArchive,
  previewAutoArchive,
  runAutoArchiveNow,
  saveAutoArchive,
  type AgeUnit,
  type AutoArchivePlan,
  type AutoArchivePolicy,
  type AutoArchiveRun,
  type AutoArchiveStatus,
} from '../../states/autoArchive'
import { SettingsGroup } from './AccountSettingsRows'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const when = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toLocaleString() : '')
const day = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toLocaleDateString() : '')
const same = (a: AutoArchivePolicy, b: AutoArchivePolicy) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Automatic archiving by age for one account (#112, ADR-0054): off until
 * turned on, and turned on only after the preview of what it will move has
 * been seen and confirmed. Every run is logged here, item by item.
 */
export function AutoArchiveGroup({ accountId }: { accountId: string }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AutoArchiveStatus | null>(null)
  const [draft, setDraft] = useState<AutoArchivePolicy | null>(null)
  const [plan, setPlan] = useState<AutoArchivePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const ran = useValue(autoArchiveRan$)

  const reload = useCallback(async () => {
    try {
      const next = await loadAutoArchive(accountId)
      setStatus(next)
      setDraft((current) => current ?? next.policy)
    } catch {
      setStatus(null)
    }
  }, [accountId])

  useEffect(() => {
    setDraft(null)
    setPlan(null)
    void reload()
  }, [reload])
  useEffect(() => {
    if (ran?.account === accountId) void reload()
  }, [ran, accountId, reload])

  if (!status || !draft) return null

  const changed = !same(draft, status.policy)
  // Anything that decides what moves needs the preview again; being on does not.
  const needsPreview = draft.enabled && (!status.confirmed || !same({ ...draft, enabled: false }, { ...status.policy, enabled: false }))
  const chosen = new Set(draft.folders.map((f) => f.name))
  const update = (next: Partial<AutoArchivePolicy>) => {
    setPlan(null)
    setDraft({ ...draft, ...next })
  }

  const preview = async () => {
    setBusy(true)
    try {
      setPlan(await previewAutoArchive(accountId, draft))
    } catch (error) {
      showToast(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const save = async (confirm?: string) => {
    setBusy(true)
    try {
      const next = await saveAutoArchive(accountId, draft, confirm)
      setStatus(next)
      setDraft(next.policy)
      setPlan(null)
      showToast(
        next.policy.enabled
          ? t('autoArchive.savedOn', { defaultValue: 'Automatic archiving is on. It runs once a day while Oreneta is open.' })
          : t('autoArchive.savedOff', { defaultValue: 'Automatic archiving saved. It is off.' }),
        'success',
      )
    } catch (error) {
      showToast(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const runNow = async () => {
    setRunning(true)
    try {
      const answer = await runAutoArchiveNow(accountId)
      setStatus(answer.status)
      const run = answer.run
      if (run.error) showToast(run.error, 'error')
      else
        showToast(
          t('autoArchive.ranToast', {
            moved: run.moved + run.kept,
            failed: run.failed,
            defaultValue:
              '{moved, plural, one {# message archived} other {# messages archived}}{failed, plural, =0 {} other {; # left where they were}}.',
          }),
          run.failed ? 'error' : 'success',
        )
    } catch (error) {
      showToast(errorText(error), 'error')
      void reload()
    } finally {
      setRunning(false)
    }
  }

  const unitLabel = (unit: AgeUnit) =>
    unit === 'days' ? t('autoArchive.days', { defaultValue: 'days' }) : t('autoArchive.months', { defaultValue: 'months' })
  const refusedLabel = (reason: string) =>
    ({
      drafts: t('autoArchive.refused.drafts', { defaultValue: 'drafts are never archived' }),
      trash: t('autoArchive.refused.trash', { defaultValue: 'deleted mail is never archived' }),
      junk: t('autoArchive.refused.junk', { defaultValue: 'junk is never archived' }),
      outbox: t('autoArchive.refused.outbox', { defaultValue: 'unsent mail is never archived' }),
      archive: t('autoArchive.refused.archive', { defaultValue: 'already the archive' }),
    })[reason] ?? reason

  const input = 'rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary'
  const button =
    'px-2.5 py-1.5 rounded-control bg-hover hover:bg-active text-primary font-bold text-2xs cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50'
  const primary =
    'px-2.5 py-1.5 rounded-control bg-accent hover:bg-accent-hover text-on-accent font-bold text-2xs cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <div data-settings-section="autoArchive" tabIndex={-1} aria-label={t('autoArchive.title', { defaultValue: 'Automatic archiving' })}>
      <SettingsGroup title={t('autoArchive.title', { defaultValue: 'Automatic archiving' })}>
        <div className="flex flex-col gap-3 px-3.5 py-3 text-caption">
          <p className="text-secondary">
            {t('autoArchive.hint', {
              defaultValue:
                'Moves old mail out of the folders you choose, once a day while Oreneta is open. Nothing moves until you have seen a preview and confirmed it. Drafts, Outbox, Trash and Junk are never archived.',
            })}
          </p>
          <label className="flex items-center gap-2 text-primary">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
            {t('autoArchive.enabled', { defaultValue: 'Archive old messages automatically' })}
          </label>
          <div className="flex flex-wrap items-center gap-2 text-secondary">
            <label className="flex items-center gap-2">
              {t('autoArchive.olderThan', { defaultValue: 'Older than' })}
              <input
                type="number"
                min={1}
                value={draft.older_than.value}
                onChange={(e) => update({ older_than: { ...draft.older_than, value: Math.max(1, Math.round(Number(e.target.value) || 1)) } })}
                className={`${input} w-16`}
              />
            </label>
            <select
              aria-label={t('autoArchive.unit', { defaultValue: 'Unit' })}
              value={draft.older_than.unit}
              onChange={(e) => update({ older_than: { ...draft.older_than, unit: e.target.value as AgeUnit } })}
              className={input}
            >
              <option value="days">{unitLabel('days')}</option>
              <option value="months">{unitLabel('months')}</option>
            </select>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-secondary">{t('autoArchive.folders', { defaultValue: 'From these folders' })}</legend>
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {status.folders.map((folder) => {
                const choice = draft.folders.find((f) => f.name === folder.name)
                return (
                  <div key={folder.name} className="flex flex-wrap items-center gap-2">
                    <label className={`flex items-center gap-2 ${folder.refused ? 'text-secondary' : 'text-primary'}`}>
                      <input
                        type="checkbox"
                        disabled={!!folder.refused}
                        checked={chosen.has(folder.name)}
                        onChange={(e) =>
                          update({
                            folders: e.target.checked
                              ? [...draft.folders, { name: folder.name, older_than: null }]
                              : draft.folders.filter((f) => f.name !== folder.name),
                          })
                        }
                      />
                      {folder.display_name}
                    </label>
                    {folder.refused && <span className="text-secondary">({refusedLabel(folder.refused)})</span>}
                    {choice && (
                      <label className="flex items-center gap-1 text-secondary">
                        {t('autoArchive.ownAge', { defaultValue: 'own age' })}
                        <input
                          type="number"
                          min={1}
                          aria-label={t('autoArchive.ownAgeFor', { folder: folder.display_name, defaultValue: 'Own age for {folder}' })}
                          placeholder={String(draft.older_than.value)}
                          value={choice.older_than?.value ?? ''}
                          onChange={(e) => {
                            const value = Math.round(Number(e.target.value))
                            update({
                              folders: draft.folders.map((f) =>
                                f.name === folder.name
                                  ? { ...f, older_than: value > 0 ? { value, unit: draft.older_than.unit } : null }
                                  : f,
                              ),
                            })
                          }}
                          className={`${input} w-14`}
                        />
                        {choice.older_than ? unitLabel(choice.older_than.unit) : ''}
                      </label>
                    )}
                  </div>
                )
              })}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1 text-primary">
            <legend className="mb-1 text-secondary">{t('autoArchive.destination', { defaultValue: 'Move them to' })}</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`auto-archive-destination-${accountId}`}
                checked={draft.destination === 'server'}
                onChange={() => update({ destination: 'server', keep_server_copy: false })}
              />
              {t('autoArchive.toServer', { defaultValue: "The account's Archive folder, on the server" })}
            </label>
            <label className={`flex items-center gap-2 ${status.local_supported ? '' : 'text-secondary'}`}>
              <input
                type="radio"
                name={`auto-archive-destination-${accountId}`}
                disabled={!status.local_supported}
                checked={draft.destination === 'local'}
                onChange={() => update({ destination: 'local' })}
              />
              {t('autoArchive.toLocal', { defaultValue: 'The local archive, on this computer' })}
            </label>
            {!status.local_supported && (
              <span className="text-secondary">
                {t('autoArchive.localUnsupported', {
                  defaultValue: 'This account cannot copy messages to the local archive.',
                })}
              </span>
            )}
            {draft.destination === 'local' && (
              <label className="ms-5 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.keep_server_copy}
                  onChange={(e) => update({ keep_server_copy: e.target.checked })}
                />
                {t('autoArchive.keepServerCopy', { defaultValue: 'Also keep them on the server' })}
              </label>
            )}
          </fieldset>
          <div className="flex flex-col gap-1 text-primary">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.include_starred} onChange={(e) => update({ include_starred: e.target.checked })} />
              {t('autoArchive.includeStarred', { defaultValue: 'Include flagged messages' })}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.include_unread} onChange={(e) => update({ include_unread: e.target.checked })} />
              {t('autoArchive.includeUnread', { defaultValue: 'Include unread messages' })}
            </label>
          </div>

          {plan && (
            <div role="region" aria-label={t('autoArchive.previewTitle', { defaultValue: 'What will be archived' })} className="flex flex-col gap-2 rounded-control border border-border px-3 py-2">
              <p className="font-bold text-primary">
                {t('autoArchive.previewTotal', {
                  count: plan.total,
                  defaultValue: '{count, plural, =0 {Nothing would be archived now.} one {# message would be archived now.} other {# messages would be archived now.}}',
                })}
              </p>
              <ul className="flex flex-col gap-0.5 text-secondary">
                {plan.folders.map((folder) => (
                  <li key={folder.folder}>
                    {t('autoArchive.previewFolder', {
                      count: folder.count,
                      folder: folder.folder,
                      target: folder.target,
                      before: day(folder.cutoff),
                      defaultValue: '{folder}: {count, plural, one {# message} other {# messages}} from before {before} → {target}',
                    })}
                  </li>
                ))}
              </ul>
              <p className="text-secondary">
                {plan.destination === 'local'
                  ? draft.keep_server_copy
                    ? t('autoArchive.previewLocalKeep', {
                        defaultValue: 'Each message is copied to the local archive and checked; the server keeps its copy.',
                      })
                    : t('autoArchive.previewLocal', {
                        defaultValue:
                          'Each message is copied to the local archive and checked before it is removed from the server.',
                      })
                  : t('autoArchive.previewServer', {
                      defaultValue: 'The messages are moved on the server; other devices will see them in the Archive folder.',
                    })}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={primary} disabled={busy} onClick={() => void save(plan.fingerprint)}>
                  {draft.enabled
                    ? t('autoArchive.confirmOn', { defaultValue: 'Confirm and turn on' })
                    : t('autoArchive.confirmSave', { defaultValue: 'Confirm and save' })}
                </button>
                <button type="button" className={button} onClick={() => setPlan(null)}>
                  {t('buttons.cancel')}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {needsPreview ? (
              <button type="button" className={button} disabled={busy || draft.folders.length === 0} onClick={() => void preview()}>
                {busy && !plan ? t('autoArchive.previewing', { defaultValue: 'Looking…' }) : t('autoArchive.preview', { defaultValue: 'Preview…' })}
              </button>
            ) : (
              <>
                <button type="button" className={button} disabled={busy || draft.folders.length === 0} onClick={() => void preview()}>
                  {t('autoArchive.preview', { defaultValue: 'Preview…' })}
                </button>
                {changed && (
                  <button type="button" className={button} disabled={busy} onClick={() => void save()}>
                    {t('buttons.save')}
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className={button}
              disabled={running || status.running || changed || !status.confirmed}
              onClick={() => void runNow()}
            >
              {running || status.running
                ? t('autoArchive.running', { defaultValue: 'Archiving…' })
                : t('autoArchive.runNow', { defaultValue: 'Run now' })}
            </button>
          </div>

          <div role="status" className="flex flex-col gap-1 text-secondary">
            {status.last_error && (status.last_attempt ?? 0) > (status.last_success ?? 0) && (
              <span className="text-danger">
                {t('autoArchive.lastFailed', {
                  when: when(status.last_attempt),
                  error: status.last_error,
                  defaultValue: 'The run of {when} did not happen: {error}',
                })}
              </span>
            )}
            {status.policy.enabled && status.next_run !== null && (
              <span>
                {t('autoArchive.next', {
                  when: when(Math.max(status.next_run, Math.floor(Date.now() / 1000))),
                  defaultValue: 'Next run: {when}',
                })}
              </span>
            )}
          </div>
          <RunLog runs={status.runs} />
        </div>
      </SettingsGroup>
    </div>
  )
}

function RunLog({ runs }: { runs: AutoArchiveRun[] }) {
  const { t } = useTranslation()
  if (runs.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <h4 className="font-bold text-primary">{t('autoArchive.log', { defaultValue: 'Run log' })}</h4>
      <ul className="flex flex-col gap-1" aria-label={t('autoArchive.log', { defaultValue: 'Run log' })}>
        {runs.map((run) => (
          <li key={run.id} className="flex flex-col gap-0.5">
            <span className="text-primary">
              {when(run.started_at)} ·{' '}
              {run.trigger === 'manual'
                ? t('autoArchive.manual', { defaultValue: 'run now' })
                : t('autoArchive.scheduled', { defaultValue: 'scheduled' })}{' '}
              ·{' '}
              {run.error
                ? t('autoArchive.runError', { error: run.error, defaultValue: 'did not run: {error}' })
                : t('autoArchive.runCounts', {
                    moved: run.moved,
                    kept: run.kept,
                    failed: run.failed,
                    defaultValue:
                      '{moved} archived{kept, plural, =0 {} other {, # copied with the server copy kept}}{failed, plural, =0 {} other {, # left where they were}}',
                  })}
            </span>
            {run.failures.length > 0 && (
              <details className="text-secondary">
                <summary className="cursor-pointer">
                  {t('autoArchive.failures', {
                    count: run.failed,
                    defaultValue: '{count, plural, one {# message not archived} other {# messages not archived}}',
                  })}
                </summary>
                <ul className="ms-4 flex flex-col gap-0.5">
                  {run.failures.map((failure) => (
                    <li key={`${failure.folder}-${failure.uid}`}>
                      {t('autoArchive.failure', {
                        subject: failure.subject || t('autoArchive.noSubject', { defaultValue: '(no subject)' }),
                        folder: failure.folder,
                        step: failure.step,
                        error: failure.error,
                        defaultValue: '{subject} ({folder}), at {step}: {error}',
                      })}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
