import { useEffect, useState } from 'react'
import { Keyboard, RotateCcw } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { ui$ } from '../../states/ui'
import {
  chordFromEvent,
  formatShortcut,
  isMac,
  SHORTCUT_GROUPS,
  SHORTCUT_LABELS,
  shortcutConflict,
  type ShortcutId,
} from '../../lib/shortcuts'
import { resetAllShortcutBindings, resetShortcutBinding, setShortcutBinding, settings$ } from '../../states/settings'
import { Button } from '../button/Button'
import { IconButton } from '../button/IconButton'
import { Dialog } from './Dialog'

/** Cheat sheet listing every global shortcut, driven off the shortcut table so
 * it stays in sync automatically. Each row is also the editor: click it and the
 * next keystroke becomes that shortcut's chord. Opened with ⌘/Ctrl+?. */
export function ShortcutsDialog() {
  const { t } = useTranslation()
  const open = useValue(ui$.shortcutsOpen)
  // Subscribes the whole sheet to rebindings, so every row re-renders after an
  // edit or a reset (formatShortcut itself reads a plain module mirror).
  const overrides = useValue(settings$.shortcutOverrides)
  // The shortcut currently listening for a keystroke, if any.
  const [recording, setRecording] = useState<ShortcutId | null>(null)
  // Which shortcut already owns the chord the user just pressed.
  const [conflict, setConflict] = useState<{ id: ShortcutId; taken: ShortcutId } | null>(null)

  // Esc (and the backdrop) cancels a recording first, else closes the sheet.
  // The shell hands Escape to the topmost layer only, so Settings underneath
  // does not close too.
  const onClose = () => {
    if (recording) {
      setRecording(null)
      setConflict(null)
    } else {
      ui$.shortcutsOpen.set(false)
    }
  }

  // The recorder runs in the capture phase and swallows the keystroke, so a
  // chord being rebound (⌘K, say) doesn't also trigger its current action.
  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return
      const chord = chordFromEvent(event)
      if (!chord) return
      event.preventDefault()
      event.stopPropagation()
      const taken = shortcutConflict(recording, chord)
      if (taken) {
        setConflict({ id: recording, taken })
        return
      }
      setShortcutBinding(recording, chord)
      setConflict(null)
      setRecording(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording])

  useEffect(() => {
    if (open) return
    setRecording(null)
    setConflict(null)
  }, [open])

  if (!open) return null

  const startRecording = (id: ShortcutId) => {
    setConflict(null)
    setRecording((current) => (current === id ? null : id))
  }

  const customized = Object.keys(overrides).length > 0

  return (
    <Dialog
      title={t('shortcuts.title')}
      subtitle={t('shortcuts.customizeHint')}
      icon={Keyboard}
      layer="raised"
      onClose={onClose}
      className="max-h-[80vh]"
      footer={
        customized ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={RotateCcw}
            onClick={() => {
              resetAllShortcutBindings()
              setRecording(null)
              setConflict(null)
            }}
          >
            {t('shortcuts.resetAll')}
          </Button>
        ) : undefined
      }
    >
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title}>
          <h3 className="mb-1.5 text-xs font-semibold text-secondary">{group.title}</h3>
          <div className="overflow-hidden rounded-control-sm border border-border">
            {group.ids.map((id, i) => (
              <ShortcutRow
                key={id}
                id={id}
                first={i === 0}
                recording={recording === id}
                conflict={conflict?.id === id ? conflict.taken : null}
                customized={!!overrides[id]}
                onEdit={() => startRecording(id)}
                onReset={() => {
                  resetShortcutBinding(id)
                  if (recording === id) setRecording(null)
                  setConflict(null)
                }}
              />
            ))}
          </div>
        </section>
      ))}
    </Dialog>
  )
}

function ShortcutRow({
  id,
  first,
  recording,
  conflict,
  customized,
  onEdit,
  onReset,
}: {
  id: ShortcutId
  first: boolean
  recording: boolean
  conflict: ShortcutId | null
  customized: boolean
  onEdit: () => void
  onReset: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className={`px-3 py-2 text-ui text-primary ${first ? '' : 'border-t border-border'}`}>
      <div className="flex items-center justify-between gap-4">
        <span>{SHORTCUT_LABELS[id]}</span>
        <div className="flex shrink-0 items-center gap-1">
          {customized && (
            <IconButton icon={RotateCcw} iconSize={13} label={t('shortcuts.resetOne')} size="sm" radius="lg" onClick={onReset} />
          )}
          <button
            type="button"
            aria-label={t('shortcuts.rebind')}
            aria-pressed={recording}
            className={`rounded border px-1.5 py-0.5 font-mono text-caption font-medium cursor-pointer ${
              recording
                ? 'border-accent text-accent'
                : 'border-border bg-app text-secondary hover:border-accent hover:text-primary'
            }`}
            onClick={onEdit}
          >
            {recording ? t('shortcuts.pressKeys') : formatShortcut(id).join(isMac ? '' : '+')}
          </button>
        </div>
      </div>
      {conflict && (
        <p role="alert" className="mt-1 text-right text-caption text-rose-600 dark:text-rose-400">
          {t('shortcuts.conflict', { name: SHORTCUT_LABELS[conflict] })}
        </p>
      )}
    </div>
  )
}
