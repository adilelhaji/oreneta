import { describe, expect, it } from 'bun:test'
import {
  draftIsEmpty,
  insertAtCaret,
  messageTemplateFields,
  messageTemplateOverwrites,
} from './applyTemplate'
import type { Template } from '../../states/templates'

const snippet: Template = {
  id: 't1',
  kind: 'snippet',
  name: 'Directions',
  subject: '',
  bodyHtml: '<p>Second floor.</p>',
  bodyText: 'Second floor.',
}

const message: Template = {
  id: 't2',
  kind: 'message',
  name: 'Weekly report',
  subject: 'Report',
  bodyHtml: '<p>Here it is.</p>',
  bodyText: 'Here it is.',
}

function draft(over: Partial<{ subject: string; text: string; html: string }> = {}) {
  return { subject: '', text: '', html: '', ...over }
}

describe('putting a snippet where the cursor is', () => {
  it('inserts at the caret', () => {
    expect(insertAtCaret('Hello world', ', there', 5, 5)).toEqual({ text: 'Hello, there world', caret: 12 })
  })

  it('replaces what was selected', () => {
    expect(insertAtCaret('Hello world', 'there', 6, 11).text).toBe('Hello there')
  })

  it('leaves the caret after what it put in', () => {
    expect(insertAtCaret('ab', 'XYZ', 1, 1).caret).toBe(4)
  })

  it('appends when nobody knows where the cursor was', () => {
    expect(insertAtCaret('Hello', '!', -1, -1).text).toBe('Hello!')
    expect(insertAtCaret('Hello', '!', 99, 99).text).toBe('Hello!')
  })

  it('does not read a backwards selection as a deletion', () => {
    expect(insertAtCaret('Hello', 'X', 3, 1).text).toBe('HelXlo')
  })
})

describe('whether there is work to lose', () => {
  it('calls a fresh composer empty', () => {
    expect(draftIsEmpty(draft())).toBe(true)
  })

  it('does not mistake an empty editor paragraph for writing', () => {
    expect(draftIsEmpty(draft({ html: '<p></p>' }))).toBe(true)
    expect(draftIsEmpty(draft({ html: '<p><br></p>' }))).toBe(true)
  })

  it('counts a subject as work', () => {
    expect(draftIsEmpty(draft({ subject: 'Hi' }))).toBe(false)
  })

  it('counts a written body as work, in either mode', () => {
    expect(draftIsEmpty(draft({ text: 'Hi' }))).toBe(false)
    expect(draftIsEmpty(draft({ html: '<p>Hi</p>' }))).toBe(false)
  })
})

describe('when a whole-message template needs asking about', () => {
  it('does not ask about an empty composer', () => {
    expect(messageTemplateOverwrites(draft(), message)).toBe(false)
  })

  it('asks before overwriting something written', () => {
    expect(messageTemplateOverwrites(draft({ text: 'Half a thought' }), message)).toBe(true)
  })

  it('never asks about a snippet, which only ever adds', () => {
    expect(messageTemplateOverwrites(draft({ text: 'Half a thought' }), snippet)).toBe(false)
  })
})

describe('the fields a message template states', () => {
  it('gives rich mode the markup', () => {
    expect(messageTemplateFields(message, true)).toEqual({
      subject: 'Report',
      html: '<p>Here it is.</p>',
      text: '',
    })
  })

  it('gives plain mode the text', () => {
    expect(messageTemplateFields(message, false)).toEqual({
      subject: 'Report',
      html: '',
      text: 'Here it is.',
    })
  })

  it('falls back rather than showing nothing when only one form was kept', () => {
    const htmlOnly: Template = { ...message, bodyText: '' }
    expect(messageTemplateFields(htmlOnly, false).text).toBe('Here it is.')
    const textOnly: Template = { ...message, bodyHtml: '' }
    expect(messageTemplateFields(textOnly, true).html).toBe('Here it is.')
  })
})
