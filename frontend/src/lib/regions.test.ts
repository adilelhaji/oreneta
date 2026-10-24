import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  focusAdjacentRegion,
  focusTargetIn,
  isShown,
  modalDialogOpen,
  REGION_ORDER,
  regionKind,
  regionOf,
  trackRegionFocus,
  visibleRegions,
} from './regions'

// happy-dom draws nothing, so these tests say what is on screen themselves:
// an element under `data-test-hidden` is not shown.
const shown = (element: HTMLElement) => !element.closest('[data-test-hidden]')

let stopTracking: () => void

beforeEach(() => {
  stopTracking = trackRegionFocus()
})

afterEach(() => {
  stopTracking()
  document.body.innerHTML = ''
})

// The mail window from 1025 px (ADR-0068 §5, #354): the folder pane with the
// module strip at its foot, a region inside it, then the list, the reader and
// its sidebar.
function mailWindow() {
  document.body.innerHTML = `
    <main aria-label="Mail">
      <nav data-region="folders" aria-label="Accounts and folders">
        <a href="#inbox" id="inbox">Inbox</a><a href="#sent" id="sent">Sent</a>
        <nav data-region="modules" aria-label="Modules"><button id="calendar">Calendar</button><button id="people">People</button></nav>
      </nav>
      <section data-region="content"><input id="search" /><button id="row" tabindex="-1">Row</button></section>
      <div data-region="reader">
        <button id="reply">Reply</button>
        <aside data-region="sidebar"><button id="details">Details</button></aside>
      </div>
    </main>
    <button id="outside">Outside</button>`
}

const focused = () => document.activeElement?.id
const step = (direction: 1 | -1) => focusAdjacentRegion(direction, document, shown)
const byId = (id: string) => document.getElementById(id) as HTMLElement

describe('region order', () => {
  it('follows the order of the frame, not the order of the document', () => {
    mailWindow()
    expect(visibleRegions(document, shown).map((region) => region.dataset.region)).toEqual([
      'folders',
      'modules',
      'content',
      'reader',
      'sidebar',
    ])
  })

  it('names every kind the ADR lists, in its order', () => {
    expect([...REGION_ORDER]).toEqual(['search', 'toolbar', 'folders', 'modules', 'content', 'reader', 'sidebar'])
  })

  it('keeps document order between regions of one kind', () => {
    document.body.innerHTML = `
      <div data-region="content" id="first"><button>A</button></div>
      <div data-region="content" id="second"><button>B</button></div>`
    expect(visibleRegions(document, shown).map((region) => region.id)).toEqual(['first', 'second'])
  })

  it('fails loudly on a kind it does not know', () => {
    document.body.innerHTML = `<div data-region="footer"><button>A</button></div>`
    expect(() => visibleRegions(document, shown)).toThrow('Unknown region kind "footer"')
    expect(() => regionKind(document.querySelector('div') as HTMLElement)).toThrow()
  })

  it('leaves out the regions that are not shown', () => {
    mailWindow()
    byId('calendar').closest('nav')!.setAttribute('data-test-hidden', '')
    expect(visibleRegions(document, shown).map((region) => region.dataset.region)).toEqual([
      'folders',
      'content',
      'reader',
      'sidebar',
    ])
    // The strip goes with the pane it is in, as below 1025 px.
    byId('calendar').closest('nav')!.removeAttribute('data-test-hidden')
    byId('inbox').closest('nav')!.setAttribute('data-test-hidden', '')
    expect(visibleRegions(document, shown).map((region) => region.dataset.region)).toEqual([
      'content',
      'reader',
      'sidebar',
    ])
  })

  it('reaches the narrow bar of 769–1024 px, which stands alone before the module, in the same place (#354)', () => {
    document.body.innerHTML = `
      <main aria-label="Mail">
        <nav data-region="modules" aria-label="Modules"><button id="calendar">Calendar</button></nav>
        <nav data-region="folders" data-test-hidden><a href="#inbox" id="inbox">Inbox</a></nav>
        <section data-region="content"><input id="search" /></section>
      </main>`
    expect(visibleRegions(document, shown).map((region) => region.dataset.region)).toEqual(['modules', 'content'])
    byId('search').focus()
    step(1)
    expect(focused()).toBe('calendar')
    step(1)
    expect(focused()).toBe('search')
  })
})

// The window since the top band (#343): the <header> before <main>, its band
// the "search" region, with the app menu's button and, open, its menu.
function bandWindow() {
  mailWindow()
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<header aria-label="Oreneta"><div data-region="search"><button id="app-menu">App menu</button><div role="menu" tabindex="0"><button role="menuitem" tabindex="-1" id="item">Item</button></div></div></header>`,
  )
}

describe('the top band (#343)', () => {
  it('is the first region, before the folders, and F6 lands on its menu button', () => {
    bandWindow()
    expect(visibleRegions(document, shown).map((region) => region.dataset.region)).toEqual([
      'search',
      'folders',
      'modules',
      'content',
      'reader',
      'sidebar',
    ])
    byId('outside').focus()
    step(1)
    expect(focused()).toBe('app-menu')
    step(-1)
    expect(focused()).toBe('details')
    step(1)
    expect(focused()).toBe('app-menu')
    step(1)
    expect(focused()).toBe('inbox')
  })

  it('leaves the band from its menu to the next region, and comes back to the button', () => {
    bandWindow()
    byId('item').focus()
    expect(regionOf(document.activeElement)?.dataset.region).toBe('search')
    step(1)
    expect(focused()).toBe('inbox')
    // The menu item went with its menu: the band's first Tab stop again.
    byId('item').closest('[role="menu"]')!.remove()
    step(-1)
    expect(focused()).toBe('app-menu')
  })
})

describe('F6 and Shift+F6', () => {
  it('goes to the first region from outside every region, and Shift+F6 to the last', () => {
    mailWindow()
    byId('outside').focus()
    step(1)
    expect(focused()).toBe('inbox')
    byId('outside').focus()
    step(-1)
    expect(focused()).toBe('details')
  })

  it('cycles through every region on screen in order, and back', () => {
    mailWindow()
    const forward: (string | undefined)[] = []
    for (let i = 0; i < 6; i++) {
      step(1)
      forward.push(focused())
    }
    // The first Tab stop of each; a row taken out of the Tab order is skipped.
    expect(forward).toEqual(['inbox', 'calendar', 'search', 'reply', 'details', 'inbox'])
    const back: (string | undefined)[] = []
    for (let i = 0; i < 5; i++) {
      step(-1)
      back.push(focused())
    }
    expect(back).toEqual(['details', 'reply', 'search', 'calendar', 'inbox'])
  })

  it('returns to the element that last had the focus in a region', () => {
    mailWindow()
    byId('row').focus()
    step(1)
    expect(focused()).toBe('reply')
    step(-1)
    // The row is out of the Tab order, but it is where the focus was.
    expect(focused()).toBe('row')
    byId('sent').focus()
    step(1)
    step(-1)
    expect(focused()).toBe('sent')
  })

  it('treats a nested region as its own: the outer one skips its elements', () => {
    mailWindow()
    byId('details').focus()
    expect(regionOf(document.activeElement)?.dataset.region).toBe('sidebar')
    step(-1)
    expect(focused()).toBe('reply')
    // The reader's first Tab stop is its own, never the sidebar's.
    const reader = byId('reply').closest<HTMLElement>('[data-region]')!
    byId('reply').remove()
    expect(focusTargetIn(reader, shown)).toBeNull()
    // Nor are the strip's buttons the folder pane's (#354).
    const folders = byId('inbox').closest<HTMLElement>('[data-region]')!
    expect(regionOf(byId('calendar'))?.dataset.region).toBe('modules')
    byId('inbox').remove()
    byId('sent').remove()
    expect(focusTargetIn(folders, shown)).toBeNull()
  })

  it('skips a region that is not shown or where nothing can take the focus', () => {
    mailWindow()
    byId('calendar').closest('nav')!.setAttribute('data-test-hidden', '')
    byId('search').setAttribute('disabled', '')
    byId('inbox').focus()
    step(1)
    // The strip is hidden and the list has only a disabled field and a row out of the Tab order.
    expect(focused()).toBe('reply')
  })

  it('does not return to a remembered element that is gone or disabled', () => {
    mailWindow()
    byId('people').focus()
    step(1)
    byId('people').setAttribute('disabled', '')
    step(-1)
    expect(focused()).toBe('calendar')
    byId('people').removeAttribute('disabled')
    byId('calendar').focus()
    step(1)
    byId('calendar').remove()
    step(-1)
    expect(focused()).toBe('people')
  })

  it('counts an inert, aria-hidden or hidden region as not shown', () => {
    mailWindow()
    const reader = byId('reply').closest<HTMLElement>('[data-region="reader"]')!
    for (const attribute of ['inert', 'aria-hidden', 'hidden']) {
      reader.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '')
      expect(isShown(reader)).toBe(false)
      expect(isShown(byId('details'))).toBe(false)
      reader.removeAttribute(attribute)
    }
  })

  it('passes over an element that refuses the focus', () => {
    mailWindow()
    byId('inbox').focus()
    // As a browser does with an element it does not draw.
    byId('calendar').focus = () => {}
    step(1)
    expect(focused()).toBe('search')
  })

  it('does nothing without regions', () => {
    document.body.innerHTML = '<button id="only">Only</button>'
    byId('only').focus()
    expect(step(1)).toBeNull()
    expect(focused()).toBe('only')
  })

  it('stays in the only region that can take the focus', () => {
    document.body.innerHTML = `
      <div data-region="content"><button id="a">A</button><button id="b">B</button></div>
      <div data-region="reader"></div>`
    byId('b').focus()
    step(1)
    expect(focused()).toBe('b')
  })
})

describe('modal dialogs', () => {
  it('are seen by their aria-modal', () => {
    document.body.innerHTML = '<section role="dialog" aria-modal="true"><button>OK</button></section>'
    expect(modalDialogOpen()).toBe(true)
    document.body.innerHTML = '<div role="dialog"><button>Spelling</button></div>'
    expect(modalDialogOpen()).toBe(false)
  })
})
