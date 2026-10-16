import { afterEach, describe, expect, it } from 'bun:test'
import {
  applyContentDirection,
  backArrow,
  besideEndX,
  directionalText,
  firstStrongDirection,
  formatNameList,
  forwardArrow,
  nameSeparator,
  documentDirection,
  elementDirection,
  endAlignedX,
  flyoutX,
  groupIndexForKey,
  inlineArrowStep,
  languageDirection,
  menuLeft,
  startEdgeX,
} from './direction'

afterEach(() => {
  document.documentElement.dir = ''
  document.body.innerHTML = ''
})

describe('which way a language is written (ADR-0061)', () => {
  it('reads Arabic, in any spelling, as right to left', () => {
    for (const code of ['ar', 'AR', 'ar-EG', 'ar_SA']) expect(languageDirection(code)).toBe('rtl')
  })

  it('reads every other catalogued language as left to right', () => {
    for (const code of ['en', 'es', 'ca', 'zh_Hant', 'zh_Hans', 'pt_BR', 'ja', 'ko', 'ru', 'tr']) {
      expect(languageDirection(code)).toBe('ltr')
    }
  })

  it('falls back to left to right when there is no language', () => {
    expect(languageDirection(undefined)).toBe('ltr')
    expect(languageDirection('')).toBe('ltr')
  })
})

describe('the direction of the document and of an element', () => {
  it('follows <html dir>', () => {
    expect(documentDirection()).toBe('ltr')
    document.documentElement.dir = 'rtl'
    expect(documentDirection()).toBe('rtl')
  })

  it('takes the nearest explicit direction above an element', () => {
    document.body.innerHTML = '<div dir="rtl"><span dir="auto"><b id="inner">x</b></span></div><i id="outer">y</i>'
    expect(elementDirection(document.getElementById('inner'))).toBe('rtl')
    expect(elementDirection(document.getElementById('outer'))).toBe('ltr')
  })
})

describe('arrow keys in reading order', () => {
  it('moves right to next in left to right, and to previous in right to left', () => {
    expect(inlineArrowStep('ArrowRight', 'ltr')).toBe(1)
    expect(inlineArrowStep('ArrowLeft', 'ltr')).toBe(-1)
    expect(inlineArrowStep('ArrowRight', 'rtl')).toBe(-1)
    expect(inlineArrowStep('ArrowLeft', 'rtl')).toBe(1)
  })

  it('ignores every other key', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'a']) {
      expect(inlineArrowStep(key, 'ltr')).toBe(0)
      expect(inlineArrowStep(key, 'rtl')).toBe(0)
    }
  })

  it('walks a group sideways in reading order and wraps at both ends', () => {
    expect(groupIndexForKey('ArrowRight', 0, 3, 'ltr')).toBe(1)
    expect(groupIndexForKey('ArrowRight', 0, 3, 'rtl')).toBe(2)
    expect(groupIndexForKey('ArrowLeft', 0, 3, 'rtl')).toBe(1)
    expect(groupIndexForKey('ArrowLeft', 2, 3, 'rtl')).toBe(0)
    expect(groupIndexForKey('ArrowLeft', 0, 3, 'ltr')).toBe(2)
  })

  it('keeps up and down top to bottom whatever the direction', () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      expect(groupIndexForKey('ArrowDown', 0, 3, direction)).toBe(1)
      expect(groupIndexForKey('ArrowUp', 0, 3, direction)).toBe(2)
    }
  })

  it('goes to the ends with Home and End', () => {
    expect(groupIndexForKey('Home', 2, 3, 'rtl')).toBe(0)
    expect(groupIndexForKey('End', 0, 3, 'rtl')).toBe(2)
  })

  it('honours the orientation: a vertical list ignores sideways arrows, a tab row the vertical ones', () => {
    expect(groupIndexForKey('ArrowLeft', 0, 3, 'rtl', 'vertical')).toBeNull()
    expect(groupIndexForKey('ArrowDown', 0, 3, 'rtl', 'horizontal')).toBeNull()
    expect(groupIndexForKey('Enter', 0, 3, 'rtl')).toBeNull()
    expect(groupIndexForKey('ArrowRight', 0, 0, 'ltr')).toBeNull()
  })

  it('starts from the first or the last item when none has focus', () => {
    expect(groupIndexForKey('ArrowRight', -1, 3, 'ltr')).toBe(0)
    expect(groupIndexForKey('ArrowLeft', -1, 3, 'ltr')).toBe(2)
  })
})

describe('where a menu opens from its button', () => {
  const rect = { left: 100, right: 140 }

  it('starts at the button start edge', () => {
    expect(startEdgeX(rect, 'ltr')).toBe(100)
    expect(startEdgeX(rect, 'rtl')).toBe(140)
  })

  it('lines up a menu end edge with the button end edge', () => {
    // A 200 px menu: its start edge is 200 px before the button's end.
    expect(endAlignedX(rect, 200, 'ltr')).toBe(-60)
    expect(endAlignedX(rect, 200, 'rtl')).toBe(300)
  })

  it('opens beside the button past its end edge', () => {
    expect(besideEndX(rect, 8, 'ltr')).toBe(148)
    expect(besideEndX(rect, 8, 'rtl')).toBe(92)
  })

  it('puts a submenu past the row end edge, or past its start edge when there is no room', () => {
    const row = { left: 300, right: 500 }
    expect(flyoutX(row, 190, 4, 1000, 'ltr')).toBe(504)
    expect(flyoutX({ left: 700, right: 900 }, 190, 4, 1000, 'ltr')).toBe(506)
    expect(flyoutX(row, 190, 4, 1000, 'rtl')).toBe(296)
    // Too close to the left edge in right to left: the menu goes to the right
    // of the row; its start (right) edge is a whole menu width past it.
    expect(flyoutX({ left: 50, right: 250 }, 190, 4, 1000, 'rtl')).toBe(444)
  })

  it('places a menu from its start edge and keeps it inside the window', () => {
    expect(menuLeft(100, 200, 1000, 8, 'ltr')).toBe(100)
    expect(menuLeft(500, 200, 1000, 8, 'rtl')).toBe(300)
    expect(menuLeft(950, 200, 1000, 8, 'ltr')).toBe(792)
    expect(menuLeft(50, 200, 1000, 8, 'rtl')).toBe(8)
  })
})

describe('a message keeps its own direction (ADR-0061)', () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

  it('gives each block of a message that declares nothing its own direction, never the body', () => {
    const doc = parse('<p>مرحبا</p><p>Hello</p><ul><li>واحد</li></ul><h2>Plan</h2><blockquote>نص</blockquote>')
    applyContentDirection(doc)
    expect(doc.body.hasAttribute('dir')).toBe(false)
    for (const element of doc.body.querySelectorAll('p, li, h2, blockquote')) {
      expect(element.getAttribute('dir')).toBe('auto')
    }
  })

  it('keeps a left-to-right newsletter laid out left to right despite an Arabic preheader', () => {
    const doc = parse(
      '<div style="display:none">عرض خاص لهذا الأسبوع</div>' +
        '<table width="600"><tr><td><img src="logo.png"></td><td>Weekly news from the shop</td></tr>' +
        '<tr><td colspan="2"><p>Read the full story</p></td></tr></table>',
    )
    applyContentDirection(doc)
    // Nothing that holds the layout takes a direction.
    expect(doc.body.hasAttribute('dir')).toBe(false)
    expect(doc.querySelector('table')!.hasAttribute('dir')).toBe(false)
    expect(doc.querySelector('td')!.hasAttribute('dir')).toBe(false)
    expect(doc.querySelector('tr')!.hasAttribute('dir')).toBe(false)
    // The preheader and the text blocks each read their own way.
    expect(doc.querySelector('div')!.getAttribute('dir')).toBe('auto')
    expect(doc.querySelectorAll('td')[1].getAttribute('dir')).toBe('auto')
    expect(doc.querySelector('p')!.getAttribute('dir')).toBe('auto')
  })

  it('lets text written straight into a body without layout take its direction', () => {
    const doc = parse('مرحبا يا آنا')
    applyContentDirection(doc)
    expect(doc.body.getAttribute('dir')).toBe('auto')
  })

  it('never turns around a message that declares its direction', () => {
    const onHtml = parse('<html dir="ltr"><body><p>مرحبا</p></body></html>')
    applyContentDirection(onHtml)
    expect(onHtml.body.hasAttribute('dir')).toBe(false)
    expect(onHtml.querySelector('p')!.hasAttribute('dir')).toBe(false)
    const onBody = parse('<body dir="rtl"><p>Hello</p></body>')
    applyContentDirection(onBody)
    expect(onBody.body.getAttribute('dir')).toBe('rtl')
    expect(onBody.querySelector('p')!.hasAttribute('dir')).toBe(false)
    const inside = parse('<div dir="ltr"><p>مرحبا</p></div><p>Hi</p>')
    applyContentDirection(inside)
    expect(inside.querySelectorAll('p')[0].hasAttribute('dir')).toBe(false)
    expect(inside.querySelectorAll('p')[1].getAttribute('dir')).toBe('auto')
  })
})

describe('the first strong character', () => {
  it('reads letters, not digits or punctuation', () => {
    expect(firstStrongDirection('12, (مرحبا) Hello')).toBe('rtl')
    expect(firstStrongDirection('— Hello مرحبا')).toBe('ltr')
    expect(firstStrongDirection('שלום')).toBe('rtl')
    expect(firstStrongDirection('日本語')).toBe('ltr')
    expect(firstStrongDirection('42 / 7')).toBeNull()
  })

  it('counts only right-to-left letters as right to left: Indic and Thai scripts are left to right', () => {
    for (const text of ['नमस्ते', 'নমস্কার', 'વંદન', 'வணக்கம்', 'สวัสดี', 'ສະບາຍດີ', 'ནམ']) {
      expect(firstStrongDirection(text)).toBe('ltr')
    }
    for (const text of ['שלום', 'مرحبا', 'ܫܠܡܐ', 'ދިވެހި', 'ߒߞߏ', 'ﻣﺮﺣﺒﺎ']) {
      expect(firstStrongDirection(text)).toBe('rtl')
    }
  })

  it('skips weak and neutral characters: byte order mark, joiners, Arabic-Indic digits, marks', () => {
    const mark = (code: number) => String.fromCodePoint(code)
    expect(firstStrongDirection(`${mark(0xfeff)}Hello`)).toBe('ltr')
    expect(firstStrongDirection(`${mark(0x200d)}${mark(0x200c)}Hello`)).toBe('ltr')
    expect(firstStrongDirection('١٢٣ Hello')).toBe('ltr')
    expect(firstStrongDirection(`${mark(0x0651)}Hello`)).toBe('ltr')
    expect(firstStrongDirection(`${mark(0xfeff)}`)).toBeNull()
    // The explicit marks are strong.
    expect(firstStrongDirection(`${mark(0x200f)}Hello`)).toBe('rtl')
    expect(firstStrongDirection(`${mark(0x200e)}مرحبا`)).toBe('ltr')
  })

  it('skips nested text that sets its own direction, as dir="auto" does', () => {
    const doc = new DOMParser().parseFromString('<p><span dir="ltr">Hello</span> مرحبا <bdi>Hi</bdi></p>', 'text/html')
    expect(firstStrongDirection(directionalText(doc.querySelector('p')!))).toBe('rtl')
  })
})

describe('names and arrows in the interface language', () => {
  it('lists names as before in a left-to-right interface', () => {
    expect(formatNameList(['Alice', 'Bob Jones'], 'en')).toBe('Alice, Bob Jones')
    expect(nameSeparator('es')).toBe(', ')
  })

  it('isolates each name and uses the Arabic comma in Arabic', () => {
    expect(formatNameList(['Alice', 'ليلى'], 'ar')).toBe('\u2068Alice\u2069\u060C \u2068ليلى\u2069')
  })

  it('isolates a right-to-left name even in a left-to-right interface', () => {
    expect(formatNameList(['ليلى', 'Bob'], 'en')).toBe('\u2068ليلى\u2069, Bob')
  })

  it('points arrows along the line', () => {
    expect(forwardArrow('ltr')).toBe('→')
    expect(forwardArrow('rtl')).toBe('←')
    expect(backArrow('ltr')).toBe('←')
    expect(backArrow('rtl')).toBe('→')
  })
})
