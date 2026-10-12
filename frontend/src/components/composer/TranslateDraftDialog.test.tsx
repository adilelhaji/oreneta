import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TranslateDraftDialog } from './TranslateDraftDialog'
import { Translator } from '../../lib/translation'
import { translationStatus$ } from '../../states/translation'

const status = {
  pairs: [
    { from: 'en', to: 'es', installed: true, size: 1, files: [] },
    { from: 'es', to: 'en', installed: true, size: 1, files: [] },
  ],
  languages: ['en', 'es'],
  used: 2,
  quota: 1024 ** 3,
  source: 'https://github.com/adilelhaji/oreneta/releases/download/translation-models-0.3.3/',
  downloading: {},
}

const seen: { text: string; html: boolean }[] = []
const translator = () =>
  new Translator(
    async () => ({
      load: async () => {},
      translate: async (_models, texts) =>
        texts.map((t) => {
          seen.push(t)
          return t.html ? '<p>Hola, <b>gracias</b>.</p>' : 'Hola, gracias por las notas.'
        }),
      stop: () => {},
    }),
    async () => new ArrayBuffer(0),
  )

beforeEach(() => {
  seen.length = 0
  translationStatus$.set(null)
  ;(window as any).go = { main: { App: { Invoke: async () => status } } }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('shows the translation for review and changes nothing until asked', async () => {
  const onApply = mock(() => {})
  const screen = render(
    <TranslateDraftDialog
      rich={false}
      html=""
      text="Hi, thanks for the notes and see you on Tuesday with the report."
      onApply={onApply}
      onClose={() => {}}
      translator={translator()}
    />,
  )
  // An English draft: from English, into the other side.
  await waitFor(() => expect((screen.getByLabelText('From') as HTMLSelectElement).value).toBe('en'))
  expect((screen.getByLabelText('into') as HTMLSelectElement).value).toBe('es')
  const use = screen.getByRole('button', { name: 'Use instead of what I wrote' }) as HTMLButtonElement
  expect(use.disabled).toBe(true)

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }))
  })
  await waitFor(() => expect(screen.getByText('Hola, gracias por las notas.')).toBeTruthy())
  expect(screen.getByText(/Nothing in your message has changed yet/)).toBeTruthy()
  expect(onApply).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Add below what I wrote' }))
  expect(onApply).toHaveBeenCalledWith({ text: 'Hola, gracias por las notas.' }, 'below')
})

it('translates a rich draft as HTML, keeping its formatting', async () => {
  const onApply = mock(() => {})
  const screen = render(
    <TranslateDraftDialog
      rich
      html="<p>Hi, <b>thanks</b>.</p>"
      text="Hi, thanks for the notes and see you on Tuesday with the report."
      onApply={onApply}
      onClose={() => {}}
      translator={translator()}
    />,
  )
  await waitFor(() => expect((screen.getByLabelText('From') as HTMLSelectElement).value).toBe('en'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }))
  })
  await waitFor(() => expect(screen.getByText('Hola, gracias.')).toBeTruthy())
  expect(seen).toEqual([{ text: '<p>Hi, <b>thanks</b>.</p>', html: true }])
  fireEvent.click(screen.getByRole('button', { name: 'Use instead of what I wrote' }))
  expect(onApply).toHaveBeenCalledWith({ html: '<p>Hola, <b>gracias</b>.</p>', text: 'Hola, gracias.' }, 'replace')
})
