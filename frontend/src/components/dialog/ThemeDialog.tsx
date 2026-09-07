import { useState } from 'react'
import { Palette, Plus } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { BUILTIN_THEMES, DEFAULT_LIGHT_ID, type Appearance, type CustomTheme, type ThemeDef } from '../../lib/themes'
import { confirmAction } from '../../states/ui'
import { deleteCustomTheme, selectTheme, settings$ } from '../../states/settings'
import { Dialog } from './Dialog'
import { ThemeEditorDialog } from './ThemeEditorDialog'
import { ThemeSwatch } from './ThemeSwatch'

// Theme picker dialog (Settings -> General -> Theme -> Change), following the
// WallpaperDialog layout: light and dark sections of large swatches, with the
// custom-theme editor reachable from a dashed tile in each section.

type EditorState = { appearance: Appearance; theme: CustomTheme | null }

function ThemeSection({
  label,
  themes,
  customThemes,
  effectiveId,
  onEdit,
  onDelete,
  newTileAppearance,
}: {
  label: string
  themes: ThemeDef[]
  customThemes: CustomTheme[]
  effectiveId: string
  onEdit: (state: EditorState) => void
  onDelete: (theme: CustomTheme) => void
  newTileAppearance: Appearance
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <span className="text-ui font-semibold text-secondary">{label}</span>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {themes.map((item) => {
          const custom = customThemes.find((candidate) => candidate.id === item.id)
          return (
            <ThemeSwatch
              key={item.id}
              theme={item}
              large
              selected={item.id === effectiveId}
              onSelect={() => selectTheme(item)}
              onEdit={custom ? () => onEdit({ appearance: custom.appearance, theme: custom }) : undefined}
              onDelete={custom ? () => onDelete(custom) : undefined}
            />
          )
        })}
        <button
          type="button"
          onClick={() => onEdit({ appearance: newTileAppearance, theme: null })}
          className="flex min-h-[112px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-control border border-dashed border-border text-secondary transition-colors hover:border-accent/50 hover:text-accent"
        >
          <Plus size={16} />
          <span className="text-caption font-bold">{t('theme.custom')}</span>
        </button>
      </div>
    </div>
  )
}

export function ThemeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [editor, setEditor] = useState<EditorState | null>(null)
  const selectedId = useValue(settings$.themeId)
  const customThemes = useValue(settings$.customThemes)

  const themes = [...BUILTIN_THEMES, ...customThemes]
  // A stale selection (deleted custom theme) highlights the default, matching
  // what resolveThemeDef actually paints.
  const effectiveId = themes.some((item) => item.id === selectedId) ? selectedId : DEFAULT_LIGHT_ID

  const onDelete = async (themeToDelete: CustomTheme) => {
    const confirmed = await confirmAction({
      title: t('theme.delete'),
      message: t('theme.deleteMessage', { name: themeToDelete.name }),
      confirmLabel: t('buttons.delete'),
      tone: 'danger',
    })
    if (confirmed) deleteCustomTheme(themeToDelete.id)
  }

  const sectionProps = {
    customThemes,
    effectiveId,
    onEdit: (state: EditorState) => setEditor(state),
    onDelete: (theme: CustomTheme) => void onDelete(theme),
  }

  return (
    <>
      {/* Raised: it opens over the settings dialog and the editor opens over it. */}
      <Dialog title={t('common.theme')} icon={Palette} width="xl" layer="raised" onClose={onClose} className="h-[620px]">
        <div className="flex flex-col gap-6">
          <ThemeSection
            label={t('theme.light')}
            themes={themes.filter((item) => item.appearance === 'light')}
            newTileAppearance="light"
            {...sectionProps}
          />
          <ThemeSection
            label={t('theme.dark')}
            themes={themes.filter((item) => item.appearance === 'dark')}
            newTileAppearance="dark"
            {...sectionProps}
          />
        </div>
      </Dialog>

      {editor && (
        <ThemeEditorDialog appearance={editor.appearance} initial={editor.theme} onClose={() => setEditor(null)} />
      )}
    </>
  )
}
