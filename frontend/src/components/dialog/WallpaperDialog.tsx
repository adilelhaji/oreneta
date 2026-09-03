import { useState } from 'react'
import { Check, Upload, Image as ImageIcon } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { ChatWallpaper } from '../../types'
import { WALLPAPER_PRESETS, sanitizeChatWallpaper, wallpaperCss } from '../../lib/wallpapers'
import { pickImageFile } from '../../lib/nativeFilePicker'
import { showToast } from '../../states/ui'
import { Dialog } from './Dialog'

function wallpaperKey(wallpaper: ChatWallpaper | null) {
  if (!wallpaper) return 'preset:plain'
  return wallpaper.kind === 'preset' ? `preset:${wallpaper.presetId}` : `custom:${wallpaper.url}`
}

// Wallpaper picker shared by account chat backgrounds and kanban board
// backgrounds: the owner decides where the selection persists via callbacks.
export function WallpaperDialog({
  title,
  previewName,
  wallpaper: rawWallpaper,
  onSelect,
  onUploadFile,
  onClose,
}: {
  title: string
  /** Seeds the avatar initial in the live preview mockup. */
  previewName?: string
  wallpaper: ChatWallpaper | null | undefined
  onSelect: (wallpaper: ChatWallpaper | null) => void | Promise<void>
  /** Upload a custom image and persist it as the selection; should throw on failure. */
  onUploadFile: (file: File) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const wallpaper = sanitizeChatWallpaper(rawWallpaper)
  const selectedKey = wallpaperKey(wallpaper)

  const uploadWallpaper = async () => {
    try {
      const file = await pickImageFile(t('wallpaper.chooseImage'))
      if (!file) return
      setBusy(true)
      await onUploadFile(file)
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('wallpaper.uploadFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const previewInfo = wallpaperCss(wallpaper)

  return (
    <Dialog title={title} icon={ImageIcon} width="2xl" layer="raised" onClose={onClose} className="h-[620px]">
      {/* Split body: the choices, and a live picture of the one chosen. */}
      <div className="-m-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-border md:flex-row">
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-3 pb-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => void uploadWallpaper()}
              disabled={busy}
              className={`relative flex aspect-[16/10] cursor-pointer flex-col items-center justify-center gap-1.5 overflow-hidden rounded-control border border-dashed transition-all ${
                selectedKey.startsWith('custom:')
                  ? 'border-accent bg-accent/5 text-accent ring-2 ring-accent/20'
                  : 'border-border text-secondary hover:border-accent/50 hover:bg-accent/2 hover:text-accent'
              } disabled:opacity-50`}
            >
              {wallpaper?.kind === 'custom' && (
                <span
                  className="absolute inset-0 bg-cover bg-center"
                  style={{
                    backgroundImage: `linear-gradient(rgba(15, 23, 42, 0.15), rgba(15, 23, 42, 0.15)), url("${wallpaper.url}")`,
                  }}
                />
              )}
              <span className="relative flex flex-col items-center gap-1 rounded-control-sm border border-border/30 bg-chats/90 px-3 py-2 shadow-xs">
                <Upload size={15} />
                <span className="text-2xs font-bold leading-none">
                  {busy ? t('wallpaper.uploading') : t('wallpaper.uploadCustom')}
                </span>
              </span>
              {selectedKey.startsWith('custom:') && <SelectedMark />}
            </button>

            {WALLPAPER_PRESETS.map((preset) => {
              const selected = selectedKey === `preset:${preset.id}`
              return (
                <button
                  key={preset.id}
                  type="button"
                  title={preset.name}
                  aria-pressed={selected}
                  onClick={() => void onSelect({ kind: 'preset', presetId: preset.id })}
                  className={`relative aspect-[16/10] cursor-pointer overflow-hidden rounded-control border transition-all ${
                    selected ? 'border-accent ring-2 ring-accent/20' : 'border-border hover:scale-[1.01] hover:border-secondary/40'
                  }`}
                >
                  <span className={`absolute inset-0 ${preset.previewClass}`} />
                  {selected && <SelectedMark />}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex w-full shrink-0 flex-col border-t border-border/70 bg-raised p-5 select-none md:w-[320px] md:border-t-0 md:border-l">
          <div className="relative flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-panel border border-border bg-chat shadow-inner">
            <div className={`absolute inset-0 transition-all duration-300 ${previewInfo.className}`} style={previewInfo.style} />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/5 to-transparent" />
            <div className="relative z-10 flex flex-1 flex-col justify-end gap-3 p-3.5">
              <div className="mx-auto rounded-full border border-border/30 bg-active px-2.5 py-0.5 text-center text-2xs font-bold text-secondary/80">
                Today
              </div>
              <div className="flex max-w-[85%] items-end gap-1.5 self-start">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/80 text-[0.53125rem] font-bold text-white shadow-xs">
                  {previewName ? previewName.slice(0, 1) : 'U'}
                </div>
                <div className="rounded-panel rounded-bl-sm border border-border bg-chats p-2.5 text-caption leading-normal text-primary shadow-xs">
                  How does this chat wallpaper look on your screen?
                </div>
              </div>
              <div className="flex max-w-[80%] flex-col self-end">
                <div className="rounded-panel rounded-br-sm border border-accent/20 bg-accent p-2.5 text-caption leading-normal text-white shadow-xs">
                  Looks fantastic! The text contrast and background pattern are perfectly balanced.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function SelectedMark() {
  return (
    <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white shadow-xs">
      <Check size={11} />
    </span>
  )
}
