import { DEFAULT_FONT_SCALE, zoomStep } from '../lib/fonts'
import { t } from '../lib/i18n'
import { settings$ } from './settings'
import { showToast } from './ui'

/**
 * Keyboard zoom (#181): moves the app-wide size, the same setting as
 * Settings → Appearance → Text size, so it is saved and comes back after a
 * restart. Says the new size, since nothing else on screen names it.
 */
export function zoom(action: 'view.zoomIn' | 'view.zoomOut' | 'view.zoomReset') {
  const current = settings$.fontScale.peek()
  const next =
    action === 'view.zoomReset' ? DEFAULT_FONT_SCALE : zoomStep(current, action === 'view.zoomIn' ? 1 : -1)
  if (next !== current) settings$.fontScale.set(next)
  showToast(t('zoom.size', { size: next, defaultValue: 'Size {size}%' }), 'info')
}
