import { afterEach, beforeEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { HtmlFrame } from './HtmlFrame'

const prototype = HTMLIFrameElement.prototype
const originalDocument = Object.getOwnPropertyDescriptor(prototype, 'contentDocument')!
const originalWindow = Object.getOwnPropertyDescriptor(prototype, 'contentWindow')!
let frameDocument: Document | null
let frameWindow: Window | null

beforeEach(() => {
  frameDocument = document.implementation.createHTMLDocument('Synthetic message')
  frameWindow = window
  Object.defineProperty(prototype, 'contentDocument', { configurable: true, get: () => frameDocument })
  Object.defineProperty(prototype, 'contentWindow', { configurable: true, get: () => frameWindow })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(prototype, 'contentDocument', originalDocument)
  Object.defineProperty(prototype, 'contentWindow', originalWindow)
})

it('waits for the frame root after mount and recovers on load without duplicate click handlers', () => {
  const doc = frameDocument!
  const root = doc.documentElement
  root.remove()
  let ready = 0
  let clicked = 0
  const view = render(<HtmlFrame html="<p>Message</p>" title="Message" onReady={() => { ready += 1 }} onFrameClick={() => { clicked += 1; return true }} />)
  expect(ready).toBe(0)
  doc.appendChild(root)
  const frame = view.getByTitle('Message')
  fireEvent.load(frame)
  expect(ready).toBe(1)
  fireEvent.load(frame)
  doc.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(clicked).toBe(1)
  expect(root.dataset.orenetaFrameLinkWired).toBe('1')
})

it('survives a srcDoc replacement whose document temporarily has no root', () => {
  let ready = 0
  let cleaned = 0
  const onReady = () => { ready += 1; return () => { cleaned += 1 } }
  const view = render(<HtmlFrame html="<p>First</p>" title="Message" onReady={onReady} />)
  const initialReady = ready
  const initialCleaned = cleaned
  const replacement = document.implementation.createHTMLDocument('Replacement')
  const root = replacement.documentElement
  root.remove()
  frameDocument = replacement
  view.rerender(<HtmlFrame html="<p>Replacement</p>" title="Message" onReady={onReady} />)
  expect(ready).toBe(initialReady)
  expect(cleaned).toBe(initialCleaned)
  replacement.appendChild(root)
  fireEvent.load(view.getByTitle('Message'))
  expect(ready).toBe(initialReady + 1)
  expect(cleaned).toBe(initialCleaned + 1)
  view.unmount()
  expect(cleaned).toBe(initialCleaned + 2)
})

it('does not announce readiness for an absent document or window', () => {
  const doc = frameDocument
  frameDocument = null
  let ready = 0
  const view = render(<HtmlFrame html="<p>Message</p>" title="Message" onReady={() => { ready += 1 }} />)
  frameDocument = doc
  frameWindow = null
  fireEvent.load(view.getByTitle('Message'))
  expect(ready).toBe(0)
  frameWindow = window
  fireEvent.load(view.getByTitle('Message'))
  expect(ready).toBe(1)
})
