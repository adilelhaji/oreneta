import { describe, expect, it } from 'bun:test'
import { APP_MODULES } from '../../states/ui'
import { fitModules, MODULE_BUTTONS, MODULE_ORDER, slotsAlong } from './moduleLayout'

// What the module switcher draws and what goes into «Més» (ADR-0068 §5, #354).

describe('the places along the module switcher', () => {
  it('counts whole places, «Més» included, and says nothing without a layout', () => {
    // The strip in a 260 px pane, less its 1 px border and 2 px each side:
    // 2 rem places at 100 %…
    expect(slotsAlong(255, 32)).toBe(7)
    // …and at the app's 200 %, where the places are 4 rem and the padding 4 px.
    expect(slotsAlong(251, 64)).toBe(3)
    // The narrowest pane, 200 px, at 100 %: five and «Més».
    expect(slotsAlong(195, 32)).toBe(6)
    // A place that fits to the pixel fits, despite the floating point.
    expect(slotsAlong(36 * 7 - 1e-9, 36)).toBe(7)
    expect(slotsAlong(0, 32)).toBeNull()
    expect(slotsAlong(252, 0)).toBeNull()
    expect(slotsAlong(Number.NaN, 32)).toBeNull()
  })
})

describe('which modules are drawn and which go into «Més»', () => {
  it('draws the seven, in the order of the strip, when they fit or before anything is measured', () => {
    expect([...MODULE_ORDER]).toEqual(['mail', 'calendar', 'people', 'tasks', 'notes', 'chat', 'attachments'])
    expect(MODULE_ORDER).toEqual(APP_MODULES)
    for (const slots of [null, 7, 8, 40])
      expect(fitModules('mail', slots)).toEqual({ shown: [...APP_MODULES], more: [] })
  })

  it('keeps a place for «Més» and fills the others in the order of the strip', () => {
    // At the app's 200 % in a 260 px pane: two buttons and «Més».
    expect(fitModules('mail', 3)).toEqual({
      shown: ['mail', 'calendar'],
      more: ['people', 'tasks', 'notes', 'chat', 'attachments'],
    })
    // The narrowest pane at 100 %: five and «Més».
    expect(fitModules('calendar', 6)).toEqual({
      shown: ['mail', 'calendar', 'people', 'tasks', 'notes'],
      more: ['chat', 'attachments'],
    })
  })

  it('never puts the active module into «Més»: it takes the last place, and both lists keep the order', () => {
    for (const active of APP_MODULES) {
      for (const slots of [1, 2, 3, 4, 5, 6]) {
        const { shown, more } = fitModules(active, slots)
        expect(shown).toContain(active)
        expect(more).not.toContain(active)
        // Every module exactly once, in the strip's order on each side.
        expect([...shown, ...more].sort()).toEqual([...APP_MODULES].sort())
        expect(shown).toEqual(APP_MODULES.filter((key) => shown.includes(key)))
        expect(more).toEqual(APP_MODULES.filter((key) => more.includes(key)))
        expect(shown).toHaveLength(Math.max(1, slots - 1))
      }
    }
    expect(fitModules('notes', 3)).toEqual({
      shown: ['mail', 'notes'],
      more: ['calendar', 'people', 'tasks', 'chat', 'attachments'],
    })
    expect(fitModules('attachments', 6).shown).toEqual(['mail', 'calendar', 'people', 'tasks', 'attachments'])
  })

  it('draws at least the active module however short the switcher is', () => {
    expect(fitModules('chat', 1)).toEqual({
      shown: ['chat'],
      more: ['mail', 'calendar', 'people', 'tasks', 'notes', 'attachments'],
    })
    expect(fitModules('chat', 0).shown).toEqual(['chat'])
  })

  it('names each module after its <main>, with an icon of its own', () => {
    expect(Object.keys(MODULE_BUTTONS)).toEqual([...APP_MODULES])
    expect(Object.values(MODULE_BUTTONS).map((button) => button.name)).toEqual([
      'shell.region.mail',
      'calendar.title',
      'people.title',
      'tasks.title',
      'notes.title',
      'messaging.title',
      'attachmentsView.title',
    ])
    expect(new Set(Object.values(MODULE_BUTTONS).map((button) => button.icon)).size).toBe(7)
  })
})
