import { AlarmClock, BellOff, CalendarClock, Mail, Moon, Play, Volume2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import type { t as translate } from '../../lib/i18n'
import { NOTIFICATION_SOUNDS, parseHm, type NotificationPrefs, type NotificationSoundId } from '../../lib/quietHours'
import { settings$ } from '../../states/settings'
import {
  notificationClock,
  pauseNotifications,
  previewSound,
  resumeNotifications,
  updateNotificationPrefs,
} from '../../states/notifications'
import { quietStatusText, useQuietState } from '../sidenav/QuietIndicator'
import { SelectInput, TextInput } from '../field/Field'
import { SettingRow, SettingsGroup, ToggleRow } from './AccountSettingsRows'

const smallButton =
  'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer bg-active/70 text-secondary hover:text-primary'

function soundLabel(id: NotificationSoundId, t: typeof translate): string {
  switch (id) {
    case 'chime':
      return t('notifications.sound.chime', { defaultValue: 'Chime' })
    case 'bell':
      return t('notifications.sound.bell', { defaultValue: 'Bell' })
    case 'pop':
      return t('notifications.sound.pop', { defaultValue: 'Pop' })
    case 'marimba':
      return t('notifications.sound.marimba', { defaultValue: 'Marimba' })
  }
}

/** Which sound, and a Play button to hear it at the chosen volume. */
function SoundChoiceRow({
  title,
  value,
  onChange,
}: {
  title: string
  value: NotificationSoundId
  onChange: (id: NotificationSoundId) => void
}) {
  const { t } = useTranslation()
  return (
    <SettingRow
      title={title}
      control={
        <div className="flex items-center gap-2">
          <SelectInput
            aria-label={title}
            value={value}
            onChange={(event) => onChange(event.target.value as NotificationSoundId)}
            className="w-32 rounded-control py-1.5 ps-3 font-semibold"
          >
            {NOTIFICATION_SOUNDS.map((id) => (
              <option key={id} value={id} className="bg-chats text-primary">
                {soundLabel(id, t)}
              </option>
            ))}
          </SelectInput>
          <button
            type="button"
            className={`${smallButton} flex items-center gap-1`}
            aria-label={t('notifications.sound.playNamed', { name: title, defaultValue: 'Play {name}' })}
            onClick={() => previewSound(value)}
          >
            <Play size={12} strokeWidth={2} aria-hidden="true" />
            {t('notifications.sound.play', { defaultValue: 'Play' })}
          </button>
        </div>
      }
    />
  )
}

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

function dayLabel(day: number): string {
  // 2024-01-07 was a Sunday; the locale names the day.
  return new Date(2024, 0, 7 + day).toLocaleDateString(undefined, { weekday: 'short' })
}

/**
 * General → Notifications (SET-01, ADR-0049): sounds for new mail and
 * reminders, do not disturb, and the daily quiet hours. Per-account muting
 * stays on each account's own page; a muted account is silent here too.
 */
export function NotificationsGroup() {
  const { t } = useTranslation()
  const prefs = useValue(settings$.notifications)
  const quiet = useQuietState()
  const set = (patch: Partial<NotificationPrefs>) => updateNotificationPrefs(patch)
  const setSchedule = (patch: Partial<NotificationPrefs['schedule']>) =>
    set({ schedule: { ...prefs.schedule, ...patch }, scheduleResumedUntil: null })
  const title = t('settings.sections.notifications', { defaultValue: 'Notifications' })

  return (
    <SettingsGroup section="notifications" title={title}>
      <ToggleRow
        icon={<Mail size={16} strokeWidth={1.75} />}
        title={t('notifications.mailSound', { defaultValue: 'Play a sound for new mail' })}
        hint={t('notifications.mailSoundHint', {
          defaultValue: 'Not for accounts whose notifications are muted, and not while notifications are quiet.',
        })}
        checked={prefs.mailSound}
        onChange={() => set({ mailSound: !prefs.mailSound })}
      />
      {prefs.mailSound && (
        <SoundChoiceRow
          title={t('notifications.mailSoundChoice', { defaultValue: 'New mail sound' })}
          value={prefs.mailSoundId}
          onChange={(id) => set({ mailSoundId: id })}
        />
      )}
      <ToggleRow
        icon={<AlarmClock size={16} strokeWidth={1.75} />}
        title={t('notifications.reminderSound', { defaultValue: 'Play a sound for reminders' })}
        hint={t('notifications.reminderSoundHint', { defaultValue: 'Calendar and task reminders.' })}
        checked={prefs.reminderSound}
        onChange={() => set({ reminderSound: !prefs.reminderSound })}
      />
      {prefs.reminderSound && (
        <SoundChoiceRow
          title={t('notifications.reminderSoundChoice', { defaultValue: 'Reminder sound' })}
          value={prefs.reminderSoundId}
          onChange={(id) => set({ reminderSoundId: id })}
        />
      )}
      {(prefs.mailSound || prefs.reminderSound) && (
        <SettingRow
          icon={<Volume2 size={16} strokeWidth={1.75} />}
          title={t('notifications.volume', { defaultValue: 'Volume' })}
          control={
            <label className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={prefs.volume}
                aria-label={t('notifications.volume', { defaultValue: 'Volume' })}
                onChange={(event) => set({ volume: Number(event.target.value) })}
                className="w-32 accent-[var(--color-accent)] cursor-pointer"
              />
              <span className="w-9 text-end text-caption font-bold text-secondary">{prefs.volume}%</span>
            </label>
          }
        />
      )}

      <SettingRow
        icon={<BellOff size={16} strokeWidth={1.75} />}
        title={t('notifications.dnd.title', { defaultValue: 'Do not disturb' })}
        hint={t('notifications.dnd.hint', {
          defaultValue:
            'No notification popups and no sounds. Unread counts keep updating. Also in the tray menu and the More menu.',
        })}
        control={
          quiet.quiet ? (
            <div className="flex items-center gap-2">
              <span className="text-caption font-semibold text-secondary">
                {quietStatusText(quiet, t, notificationClock.now())}
              </span>
              <button type="button" className={smallButton} onClick={() => resumeNotifications()}>
                {t('notifications.dnd.resumeShort', { defaultValue: 'Resume' })}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-1">
              <button type="button" className={smallButton} onClick={() => pauseNotifications('hour')}>
                {t('notifications.dnd.hour', { defaultValue: 'For 1 hour' })}
              </button>
              <button type="button" className={smallButton} onClick={() => pauseNotifications('tomorrow')}>
                {t('notifications.dnd.tomorrow', { defaultValue: 'Until tomorrow' })}
              </button>
              <button type="button" className={smallButton} onClick={() => pauseNotifications('off')}>
                {t('notifications.dnd.untilOff', { defaultValue: 'Until turned off' })}
              </button>
            </div>
          )
        }
      />
      <ToggleRow
        icon={<Moon size={16} strokeWidth={1.75} />}
        title={t('notifications.schedule.enabled', { defaultValue: 'Quiet hours' })}
        hint={t('notifications.schedule.hint', {
          defaultValue:
            'Every week on the chosen days, in this computer’s time zone. An end before the start runs past midnight into the next day.',
        })}
        checked={prefs.schedule.enabled}
        onChange={() => setSchedule({ enabled: !prefs.schedule.enabled })}
      />
      {prefs.schedule.enabled && (
        <>
          <SettingRow
            title={t('notifications.schedule.time', { defaultValue: 'From – to' })}
            control={
              <div className="flex items-center gap-1.5">
                <TextInput
                  type="time"
                  aria-label={t('notifications.schedule.start', { defaultValue: 'Quiet hours start' })}
                  value={prefs.schedule.start}
                  onChange={(event) => {
                    if (parseHm(event.target.value) !== null) setSchedule({ start: event.target.value })
                  }}
                  className="w-28 font-semibold"
                />
                <span className="text-secondary">–</span>
                <TextInput
                  type="time"
                  aria-label={t('notifications.schedule.end', { defaultValue: 'Quiet hours end' })}
                  value={prefs.schedule.end}
                  onChange={(event) => {
                    if (parseHm(event.target.value) !== null) setSchedule({ end: event.target.value })
                  }}
                  className="w-28 font-semibold"
                />
              </div>
            }
          />
          <SettingRow
            title={t('notifications.schedule.days', { defaultValue: 'Days' })}
            control={
              <div
                className="flex items-center gap-0.5"
                role="group"
                aria-label={t('notifications.schedule.days', { defaultValue: 'Days' })}
              >
                {DAY_ORDER.map((day) => {
                  const on = prefs.schedule.days.includes(day)
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setSchedule({
                          days: on
                            ? prefs.schedule.days.filter((d) => d !== day)
                            : [...prefs.schedule.days, day].sort((a, b) => a - b),
                        })
                      }
                      className={`rounded-md px-1.5 py-1 text-xs font-semibold transition-colors cursor-pointer ${
                        on ? 'bg-chats text-accent shadow-sm' : 'text-secondary hover:text-primary'
                      }`}
                    >
                      {dayLabel(day)}
                    </button>
                  )
                })}
              </div>
            }
          />
        </>
      )}
      <ToggleRow
        icon={<CalendarClock size={16} strokeWidth={1.75} />}
        title={t('notifications.remindersWhileQuiet', { defaultValue: 'Still show reminders while quiet' })}
        hint={t('notifications.remindersWhileQuietHint', {
          defaultValue:
            'Calendar and task reminders are time-critical, so they get through do not disturb unless this is off.',
        })}
        checked={prefs.remindersWhileQuiet}
        onChange={() => set({ remindersWhileQuiet: !prefs.remindersWhileQuiet })}
      />
    </SettingsGroup>
  )
}
