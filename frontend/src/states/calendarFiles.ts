// .ics files in and out of a calendar (#101). Importing shows what would be
// added first; nothing is added twice.
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { confirmAction, showToast } from './ui'
import type { Calendar } from './calendar'

export type ImportSummary = { added: number; duplicates: number; skipped: number; series: number }

/** Whether a calendar can take imported events: local, or CalDAV it may write. */
export function canImportInto(calendar: Pick<Calendar, 'kind' | 'read_only'>): boolean {
  return calendar.kind === 'local' || (calendar.kind === 'caldav' && !calendar.read_only)
}

function reason(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export async function importIcs(calendar: Pick<Calendar, 'accountId' | 'id' | 'name'>) {
  const target = { account: calendar.accountId, calendar: calendar.id }
  try {
    const preview = await invoke<{ cancelled?: boolean; summary?: ImportSummary; path?: string }>(
      'calendar.importIcs',
      target,
    )
    if (preview?.cancelled || !preview?.summary || !preview.path) return
    const { added, duplicates, series } = preview.summary
    if (added === 0) {
      showToast(
        t('calendar.importNothing', {
          count: duplicates,
          defaultValue: 'Nothing to add: {count, plural, one {# event is} other {# events are}} already there',
        }),
      )
      return
    }
    const confirmed = await confirmAction({
      title: t('calendar.importTitle', { name: calendar.name, defaultValue: 'Import into {name}?' }),
      message: t('calendar.importText', {
        added,
        series,
        duplicates,
        defaultValue:
          '{added, plural, one {# event} other {# events}} will be added ({series} repeating). {duplicates} already there will be left as they are.',
      }),
      confirmLabel: t('calendar.importAction', { defaultValue: 'Import' }),
    })
    if (!confirmed) return
    const done = await invoke<{ summary: ImportSummary }>('calendar.importIcs', {
      ...target,
      path: preview.path,
      confirm: true,
    })
    showToast(
      t('calendar.imported', {
        count: done.summary.added,
        defaultValue: '{count, plural, one {Imported # event} other {Imported # events}}',
      }),
    )
  } catch (error) {
    showToast(
      reason(error, t('calendar.importFailed', { defaultValue: 'The calendar file was not imported' })),
      'error',
    )
  }
}

export async function exportIcs(calendar: Pick<Calendar, 'accountId' | 'id' | 'name'>) {
  try {
    const res = await invoke<{ saved: boolean; events?: number }>('calendar.exportIcs', {
      account: calendar.accountId,
      calendar: calendar.id,
      name: calendar.name,
    })
    if (res?.saved)
      showToast(
        t('calendar.exported', {
          count: res.events ?? 0,
          defaultValue: '{count, plural, one {Exported # event} other {Exported # events}}',
        }),
      )
  } catch (error) {
    showToast(reason(error, t('calendar.exportFailed', { defaultValue: 'The calendar was not exported' })), 'error')
  }
}
