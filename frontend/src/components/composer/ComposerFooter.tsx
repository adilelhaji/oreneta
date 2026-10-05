import { Paperclip, Image as ImageIcon, RefreshCw, Send, Type } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { sendShortcutLabel } from '../../states/settings'
import type { Template } from '../../states/templates'
import { IconButton } from '../button/IconButton'
import { SendLaterMenu } from './SendLaterMenu'
import { TemplateMenu } from './TemplateMenu'
import { ProtectionComposeControls } from './ProtectionComposeControls'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

// The composer's bottom action bar: attach/inline-image buttons, the rich/plain
// toggle, autosave status and the Discard/Send buttons.
export function ComposerFooter({
  rich,
  sending,
  saveStatus,
  saveError,
  canSend,
  onPickFiles,
  onPickInlineImages,
  onToggleRich,
  onUseTemplate,
  pgpSign,
  pgpEncrypt,
  pgpPassphrase,
  onPgpSignChange,
  onPgpEncryptChange,
  onPgpPassphraseChange,
  onDiscard,
  onSubmit,
  onSchedule,
}: {
  rich: boolean
  sending: boolean
  saveStatus: SaveStatus
  saveError?: string
  canSend: boolean
  onPickFiles: () => void
  onPickInlineImages: () => void
  onToggleRich: () => void
  /** Puts a kept snippet in at the cursor, or opens a whole-message template. */
  onUseTemplate: (template: Template) => void
  pgpSign: boolean
  pgpEncrypt: boolean
  pgpPassphrase: string
  onPgpSignChange: (value: boolean) => void
  onPgpEncryptChange: (value: boolean) => void
  onPgpPassphraseChange: (value: string) => void
  onDiscard: () => void
  onSubmit: () => void
  /** Holds the message until `at` instead of sending it now. */
  onSchedule: (at: number) => void
}) {
  const { t } = useTranslation()
  const draftAutosaveFailed = t('composer.status.draftAutosaveFailed')

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-header px-4 py-2.5 select-none">
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
        <IconButton
          icon={Paperclip}
          iconSize={16}
          label={t('composer.actions.attachFiles')}
          radius="xl"
          onClick={onPickFiles}
        />
        {rich && (
          <IconButton
            icon={ImageIcon}
            iconSize={16}
            label={t('composer.actions.insertInlineImage')}
            radius="xl"
            onClick={onPickInlineImages}
          />
        )}
        <TemplateMenu onPick={onUseTemplate} />
        <ProtectionComposeControls
          sign={pgpSign}
          encrypt={pgpEncrypt}
          passphrase={pgpPassphrase}
          onSignChange={onPgpSignChange}
          onEncryptChange={onPgpEncryptChange}
          onPassphraseChange={onPgpPassphraseChange}
        />
        <button
          onClick={onToggleRich}
          className={`flex h-9 items-center gap-1.5 rounded-control px-2.5 text-caption font-semibold transition-colors cursor-pointer ${
            rich ? 'bg-accent/10 text-accent' : 'text-secondary hover:bg-hover'
          }`}
          title={rich ? t('composer.actions.switchToPlainText') : t('composer.actions.switchToRichText')}
        >
          <Type size={16} strokeWidth={1.75} />
          {rich ? t('composer.modes.richText') : t('composer.modes.plainText')}
        </button>
      </div>
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-3">
        {saveStatus === 'saving' && (
          <span className="flex items-center gap-1.5 text-caption text-secondary">
            <RefreshCw size={14} className="animate-spin" strokeWidth={1.75} />
            <span>{t('composer.status.savingDraft')}</span>
          </span>
        )}
        {saveStatus === 'saved' && (
          <span className="flex items-center gap-1.5 text-caption text-success font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
            <span>{t('composer.status.savedToServer')}</span>
          </span>
        )}
        {saveStatus === 'error' && (
          <span
            role="alert"
            className="max-w-full wrap-anywhere text-caption text-danger font-medium"
            title={saveError || draftAutosaveFailed}
          >
            {saveError || draftAutosaveFailed}
          </span>
        )}
        <button
          onClick={onDiscard}
          disabled={sending}
          className="rounded-control px-4 py-2 text-xs font-semibold text-secondary transition-colors hover:bg-hover cursor-pointer disabled:opacity-50"
        >
          {t('buttons.discard')}
        </button>
        <SendLaterMenu
          disabled={!canSend || pgpSign || pgpEncrypt}
          title={pgpSign || pgpEncrypt ? t('crypto.cannotSchedule') : undefined}
          onSchedule={onSchedule}
        />
        <button
          onClick={onSubmit}
          disabled={!canSend}
          title={t('composer.actions.sendWithShortcut', { shortcut: sendShortcutLabel('mod_enter') })}
          className={`flex items-center justify-center gap-1.5 rounded-control px-5 py-2 text-xs font-bold transition-all ${
            !canSend
              ? 'cursor-not-allowed bg-hover text-secondary/70 shadow-none'
              : 'bg-accent text-on-accent  hover:bg-accent-hover   cursor-pointer'
          }`}
        >
          {sending ? (
            <RefreshCw size={14} className="animate-spin" strokeWidth={1.75} />
          ) : (
            <Send size={14} strokeWidth={1.75} />
          )}
          <span>{t('buttons.send')}</span>
        </button>
      </div>
    </div>
  )
}
