import { invoke } from '../lib/bridge'
import i18n, { t, translationTemplate, type LanguageChoice, type SupportedI18nLanguage } from '../lib/i18n'
import { applyDocumentLanguage, bootstrapLanguage, interfaceLanguage } from './settings'

/**
 * The language the interface shows now (ADR-0062): until the profile's choice
 * is read, the one the last run showed (Catalan on a fresh profile); after,
 * the choice — Catalan when nobody has chosen, whatever the system speaks.
 */
export function targetInterfaceLanguage(choice: LanguageChoice | null, loaded: boolean): SupportedI18nLanguage {
  return loaded ? interfaceLanguage(choice) : bootstrapLanguage
}

/** The tray and notification wording Go shows itself, in the current language. */
export function nativeLabels(): Record<string, string> {
  return {
    trayShow: t('tray.showOreneta'),
    trayHide: t('tray.hideToTray'),
    trayHideTooltip: t('tray.hideOrenetaTooltip'),
    trayQuit: t('tray.quitOreneta'),
    trayDoNotDisturb: t('tray.doNotDisturb', { defaultValue: 'Do not disturb' }),
    newMessage: t('notify.newMessage'),
    newMessageCount: translationTemplate('notify.newMessageCount'),
    noSubject: t('notify.noSubject'),
    unknownSender: t('notify.unknownSender'),
    // Go puts the time (and the date, when not today) in place of {time}.
    reminderStarted: translationTemplate('notify.reminderStarted'),
    missedReminders: translationTemplate('notify.missedReminders'),
  }
}

/**
 * Shows the interface in `language`: the strings, Go's own tray and
 * notification labels, and <html lang>/dir, which drive :lang() CJK glyph
 * selection (see index.css) and RTL and refresh the paint-time cache.
 */
export function applyInterfaceLanguage(language: SupportedI18nLanguage) {
  if (i18n.language !== language) {
    void i18n.changeLanguage(language)
  }
  void invoke('i18n.setNativeLabels', nativeLabels()).catch(() => {})
  applyDocumentLanguage(language)
}
