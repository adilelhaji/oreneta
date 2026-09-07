import { useState } from 'react'
import { Palette } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { isValidColor, luminance } from '../../lib/color'
import {
  cssVarStyle,
  defaultCustomInput,
  deriveThemeTokens,
  newCustomThemeId,
  type Appearance,
  type CustomTheme,
  type CustomThemeInput,
} from '../../lib/themes'
import { upsertCustomTheme } from '../../states/settings'
import { Button } from '../button/Button'
import { TextInput } from '../field/Field'
import { Dialog } from './Dialog'

// Custom theme editor, layered over Settings (same pattern as
// AvatarCropDialog: z-[70] overlay + capture-phase Esc so the Settings dialog
// underneath doesn't also close). The user edits 5 colors + appearance; the
// remaining tokens are derived (lib/themes.ts) and shown in a live preview.

type ColorField = keyof Omit<CustomThemeInput, 'appearance'>

const COLOR_FIELDS: { key: ColorField; labelKey: string; hintKey: string }[] = [
  { key: 'bgApp', labelKey: 'theme.fields.background', hintKey: 'theme.fields.backgroundHint' },
  { key: 'surface', labelKey: 'theme.fields.surface', hintKey: 'theme.fields.surfaceHint' },
  { key: 'sideNav', labelKey: 'theme.fields.sideNav', hintKey: 'theme.fields.sideNavHint' },
  { key: 'accent', labelKey: 'theme.fields.accent', hintKey: 'theme.fields.accentHint' },
  { key: 'text', labelKey: 'theme.fields.text', hintKey: 'theme.fields.textHint' },
]

/** Normalized "#rrggbb" for the native color input, or null if not expressible. */
function toHex6(value: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null
}

export function ThemeEditorDialog({
  appearance,
  initial,
  onClose,
}: {
  appearance: Appearance
  initial: CustomTheme | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name ?? '')
  const [input, setInput] = useState<CustomThemeInput>(initial?.source ?? defaultCustomInput(appearance))
  // Until a color is touched, flipping appearance reseeds the palette so a new
  // dark theme doesn't start from light colors.
  const [dirty, setDirty] = useState(initial !== null)

  const setColor = (key: ColorField, value: string) => {
    setDirty(true)
    setInput((current) => ({ ...current, [key]: value }))
  }

  const setAppearance = (next: Appearance) => {
    setInput((current) => (dirty ? { ...current, appearance: next } : defaultCustomInput(next)))
  }

  const valid = COLOR_FIELDS.every(({ key }) => isValidColor(input[key]))
  const tokens = valid ? deriveThemeTokens(input) : null

  const save = () => {
    if (!tokens) return
    upsertCustomTheme({
      id: initial?.id ?? newCustomThemeId(),
      name: name.trim() || t('theme.customTheme'),
      appearance: input.appearance,
      tokens,
      source: input,
    })
    onClose()
  }

  return (
    <Dialog
      title={initial ? t('theme.edit') : t('theme.new')}
      icon={Palette}
      width="lg"
      layer="raised"
      onClose={onClose}
      className="max-h-[80vh]"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('buttons.cancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={!valid}>
            {t('theme.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <TextInput
            type="text"
            value={name}
            placeholder={t('theme.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
            surface="raised"
            className="flex-1 rounded-control px-3 py-2 font-semibold"
          />
          <div className="flex shrink-0 items-center gap-0.5 rounded-control-sm bg-active/70 p-0.5">
            {(['light', 'dark'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setAppearance(mode)}
                className={`rounded-md px-2.5 py-1 text-caption font-bold capitalize transition-colors cursor-pointer ${
                  input.appearance === mode ? 'bg-chats text-accent shadow-sm' : 'text-secondary hover:text-primary'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {COLOR_FIELDS.map(({ key, labelKey, hintKey }) => (
            <ColorRow
              key={key}
              label={t(labelKey)}
              hint={t(hintKey)}
              value={input[key]}
              onChange={(value) => setColor(key, value)}
            />
          ))}
        </div>

        {tokens && <ThemePreview tokens={tokens} />}
      </div>
    </Dialog>
  )
}

function ColorRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const hex = toHex6(value)
  const invalid = !isValidColor(value)
  return (
    <div className="flex items-center justify-between gap-3 rounded-control bg-raised border border-border/50 px-3 py-2">
      <div className="min-w-0">
        <span className="block text-caption font-bold text-primary">{label}</span>
        <span className="block text-2xs text-secondary font-medium truncate">{hint}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          type="color"
          value={hex ?? '#000000'}
          onChange={(event) => onChange(event.target.value)}
          title={t('theme.pickColor', { label: label.toLowerCase() })}
          className="h-7 w-8 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
        />
        <TextInput
          type="text"
          value={value}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          invalid={invalid}
          className="w-24 px-2 py-1.5 text-caption font-mono font-semibold"
        />
      </div>
    </div>
  )
}

// A static mock of the main layout, themed by scoping the candidate tokens to
// this subtree with inline vars — the token utilities inside then resolve to
// the draft theme instead of the active one.
function ThemePreview({ tokens }: { tokens: ReturnType<typeof deriveThemeTokens> }) {
  const onAccent = luminance(tokens.accent) > 0.6 ? '#0f172a' : '#ffffff'
  return (
    <div
      className="overflow-hidden rounded-panel border select-none"
      style={{ ...cssVarStyle(tokens), borderColor: tokens.border }}
    >
      <div className="flex h-40 bg-app">
        <div className="w-9 shrink-0 bg-sidenav p-1.5">
          <div className="mx-auto h-6 w-6 rounded-control-sm" style={{ background: tokens.accent }} />
        </div>
        <div className="w-28 shrink-0 border-r border-border bg-chats p-1.5 flex flex-col gap-1">
          <div className="rounded-control-sm bg-accent/15 px-1.5 py-1">
            <div className="text-2xs font-bold text-accent">Alice</div>
            <div className="text-[0.4375rem] text-secondary truncate">See you tomorrow!</div>
          </div>
          <div className="px-1.5 py-1">
            <div className="text-2xs font-bold text-primary">Bob</div>
            <div className="text-[0.4375rem] text-secondary truncate">Thanks for the update</div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col bg-chat">
          <div className="border-b border-border bg-header px-2 py-1 text-2xs font-bold text-primary">Alice</div>
          <div className="flex flex-1 flex-col justify-end gap-1 p-2">
            <div className="self-start rounded-control-sm bg-bubble-in px-1.5 py-1 text-[0.46875rem] text-bubble-in-text shadow-bubble-in">
              Are we still on for lunch?
            </div>
            <div className="self-end rounded-control-sm bg-bubble-out px-1.5 py-1 text-[0.46875rem] text-bubble-out-text shadow-bubble-out">
              Yes — see you tomorrow!
            </div>
          </div>
          <div className="border-t border-composer-border bg-composer-bg px-2 py-1 flex items-center justify-between">
            <span className="text-[0.46875rem] text-secondary">Message</span>
            <span
              className="rounded-full px-1.5 py-0.5 text-[0.4375rem] font-bold"
              style={{ background: tokens.accent, color: onAccent }}
            >
              Send
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
