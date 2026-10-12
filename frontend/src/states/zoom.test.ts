import { beforeEach, expect, it } from 'bun:test'
import { settings$ } from './settings'
import { ui$ } from './ui'
import { zoom } from './zoom'

beforeEach(() => settings$.fontScale.set(100))

it('steps the app-wide size up to 200%, down to 80% and back, saying each size', () => {
  zoom('view.zoomIn')
  expect(settings$.fontScale.get()).toBe(110)
  expect(ui$.toast.get()).toBe('Size 110%')
  for (let i = 0; i < 10; i++) zoom('view.zoomIn')
  expect(settings$.fontScale.get()).toBe(200)
  expect(document.documentElement.style.fontSize).toBe('32px')
  zoom('view.zoomReset')
  expect(settings$.fontScale.get()).toBe(100)
  expect(document.documentElement.style.fontSize).toBe('')
  for (let i = 0; i < 5; i++) zoom('view.zoomOut')
  expect(settings$.fontScale.get()).toBe(80)
  expect(ui$.toast.get()).toBe('Size 80%')
})
