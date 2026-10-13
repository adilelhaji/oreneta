import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MessageContent } from './MessageContent'
import { settleConfirm, ui$ } from '../../states/ui'
import { setAppTranslator, Translator, type ModelPair } from '../../lib/translation'
import {
  messageTranslations$,
  onTranslationEvent,
  startMessageTranslation,
  translationStatus$,
} from '../../states/translation'

const calls: { command: string; payload: any }[] = []
let answers: Record<string, (payload: any) => unknown> = {}

const pair = (from: string, to: string, installed: boolean): ModelPair => ({
  from,
  to,
  installed,
  size: 22_000_000,
  files: [],
})
const status = (installed: boolean) => ({
  pairs: [pair('es', 'en', installed), pair('en', 'es', installed), pair('nb', 'en', false)],
  languages: ['en', 'es', 'nb'],
  used: 0,
  quota: 1024 ** 3,
  source: 'https://github.com/adilelhaji/oreneta/releases/download/translation-models-0.3.3/',
  downloading: {},
})

const original = 'Hola Marta, te mando el presupuesto para la cocina. Gracias por todo y hasta el martes.'
const message = () =>
  ({
    id: 'm1',
    thread_id: 'acct#INBOX#t',
    account_id: 'acct',
    subject: 'Presupuesto',
    body: original,
    attachments: [],
  }) as any
const view = () =>
  ({
    attachmentImages: [],
    bubbleAttachmentImages: [],
    videos: [],
    hiddenRemoteCount: 0,
    files: [],
    useHtmlBody: false,
    normalizedSearchQuery: '',
    activeSearchMatch: false,
  }) as any

// Stands in for Bergamot: the real one is checked by Node and the e2e suite.
const translated: string[] = []
const fakeTranslator = () =>
  new Translator(
    async () => ({
      load: async () => {},
      translate: async (_models, texts) => texts.map((t) => (translated.push(t.text), 'Hi Marta, here is the budget.')),
      stop: () => {},
    }),
    async () => new ArrayBuffer(0),
  )

beforeEach(() => {
  calls.length = 0
  translated.length = 0
  answers = { 'translation.status': () => status(true) }
  messageTranslations$.set({})
  translationStatus$.set(null)
  setAppTranslator(fakeTranslator())
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return answers[command]?.(payload) ?? {}
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
  ui$.confirm.set(null)
  setAppTranslator(null)
})

it('asks which languages, then shows the translation in place of the text and keeps the original', async () => {
  const msg = message()
  const screen = render(<MessageContent message={msg} view={view()} galleryOffset={0} />)
  await act(async () => {
    await startMessageTranslation(msg)
  })
  // The guess: Spanish, into the app's language.
  expect((screen.getByLabelText('From') as HTMLSelectElement).value).toBe('es')
  expect((screen.getByLabelText('into') as HTMLSelectElement).value).toBe('en')
  expect(screen.getByText('Runs on this computer.')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }))
  })
  await waitFor(() => expect(screen.getByText('Hi Marta, here is the budget.')).toBeTruthy())
  expect(screen.getByText(/Machine translation from Spanish into English/)).toBeTruthy()
  expect(msg.body).toBe(original)
  fireEvent.click(screen.getByRole('button', { name: 'Show original' }))
  expect(screen.getByText(original)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show translation' }))
  expect(screen.getByText('Hi Marta, here is the budget.')).toBeTruthy()
  expect(calls.some((c) => c.command === 'translation.download')).toBe(false)
})

it('downloads a missing model only after saying its size and source, and translates once it is here', async () => {
  answers['translation.status'] = () => status(false)
  const msg = message()
  const screen = render(<MessageContent message={msg} view={view()} galleryOffset={0} />)
  await act(async () => {
    await startMessageTranslation(msg)
  })
  expect(screen.getByText('Needs a 21 MB download first; asked before it starts.')).toBeTruthy()

  // Declined: nothing is fetched.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }))
  })
  await waitFor(() => expect(ui$.confirm.get()).toBeTruthy())
  expect(ui$.confirm.get()?.message).toContain('from github.com')
  expect(ui$.confirm.get()?.message).toContain('no text is sent anywhere')
  await act(async () => settleConfirm(false))
  expect(calls.some((c) => c.command === 'translation.download')).toBe(false)
  expect(translated).toEqual([])

  // Agreed: the core fetches it; the translation starts when it is in place.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }))
  })
  await waitFor(() => expect(ui$.confirm.get()).toBeTruthy())
  await act(async () => settleConfirm(true))
  await waitFor(() => expect(calls.some((c) => c.command === 'translation.download')).toBe(true))
  expect(calls.find((c) => c.command === 'translation.download')?.payload).toEqual({ from: 'es', to: 'en' })
  answers['translation.status'] = () => status(true)
  await act(async () => onTranslationEvent('translation.done', { key: 'esen', error: null }))
  await waitFor(() => expect(screen.getByText('Hi Marta, here is the budget.')).toBeTruthy())
})

it('says plainly when a download did not check out, and keeps the original', async () => {
  answers['translation.status'] = () => status(false)
  const msg = message()
  const screen = render(<MessageContent message={msg} view={view()} galleryOffset={0} />)
  await act(async () => {
    await startMessageTranslation(msg)
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }))
  })
  await waitFor(() => expect(ui$.confirm.get()).toBeTruthy())
  await act(async () => settleConfirm(true))
  await waitFor(() => expect(calls.some((c) => c.command === 'translation.download')).toBe(true))
  await act(async () =>
    onTranslationEvent('translation.done', {
      key: 'esen',
      error: { message: 'x', detail: { code: 'integrity' } } as any,
    }),
  )
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('did not match the published model'))
  expect(screen.getByText(original)).toBeTruthy()
})

it('offers nothing to translate with when no model covers the pair', async () => {
  const msg = message()
  const screen = render(<MessageContent message={msg} view={view()} galleryOffset={0} />)
  await act(async () => {
    await startMessageTranslation(msg)
  })
  fireEvent.change(screen.getByLabelText('From'), { target: { value: 'en' } })
  fireEvent.change(screen.getByLabelText('into'), { target: { value: 'nb' } })
  expect(screen.getByText('No model translates between these.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Translate' }) as HTMLButtonElement).disabled).toBe(true)
})
