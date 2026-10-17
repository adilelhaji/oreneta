import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Message } from '../types'
import { compose$, forwardMessage, openComposeTab, openReplyInFullEditor, sendReply, updateComposeDraft } from './compose'
import { accounts$ } from './accounts'
import {
  hydrateSettings,
  sanitizeSignaturePlacements,
  setSignaturePlacement,
  settings$,
  signaturePlacementFor,
} from './settings'
import { ui$ } from './ui'
import { mail$ } from './mail'
import { DEFAULT_REPLY_FORWARD_PREFS, type ReplyForwardPrefs } from '../lib/replyForward'
import i18n from '../lib/i18n'
import { formatFullTimestamp } from '../components/chat/messageHelpers'

// Mail → Replies and forwards (ADR-0047), as the composer applies it.

const calls: { command: string; payload: any }[] = []
let rawReply: (() => unknown) | null = null

const account = {
  id: 'acc-1',
  email: 'me@example.com',
  display_name: 'Me',
  provider: 'custom',
  auth_type: 'password' as const,
  imap_host: 'imap.example.com',
  imap_port: 993,
  smtp_host: 'smtp.example.com',
  smtp_port: 465,
  tls: true,
  conversation_html: false,
}

const DATE = Math.floor(Date.UTC(2026, 5, 11, 12, 0) / 1000)

const original = (overrides: Partial<Message> = {}): Message => ({
  id: 'acc-1#INBOX#k1#42',
  account_id: 'acc-1',
  folder_id: 'INBOX',
  thread_id: 'acc-1#INBOX#k1',
  from_name: 'Ana <Ops> & Co',
  from_addr: 'ana@example.com',
  to: 'me@example.com',
  subject: 'RE: Re: Plan',
  preview: '',
  body: 'Line one\nLine two',
  message_id: 'root@example.com',
  date: DATE,
  unread: false,
  starred: false,
  has_attachments: false,
  ...overrides,
})

const setPrefs = (overrides: Partial<ReplyForwardPrefs>) =>
  settings$.replyForward.set({ ...DEFAULT_REPLY_FORWARD_PREFS, ...overrides })

const openThread = (message: Message) => {
  mail$.threads.set([message])
  mail$.messages.set([message])
  ui$.selectedThread.set(message.thread_id)
}

const draft = () => compose$.tabs.get()[0]?.compose

beforeEach(() => {
  calls.length = 0
  rawReply = null
  compose$.tabs.set([])
  compose$.activeTab.set('')
  compose$.composer.set('')
  compose$.composerAttachments.set([])
  compose$.quickReplyDraftId.set('')
  compose$.quickReplyDraftSaved.set(false)
  compose$.quickReplyFrom.set('')
  compose$.quickReplySignature.set(null)
  mail$.messages.set([])
  mail$.threads.set([])
  ui$.selectedThread.set('')
  ui$.selectedAccount.set('acc-1')
  ui$.toast.set('')
  accounts$.set([account])
  settings$.signature.set('')
  settings$.undoSendSeconds.set(0)
  settings$.replyForward.set(DEFAULT_REPLY_FORWARD_PREFS)
  settings$.signaturePlacement.set({})
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'mail.allocateIdentity') return { message_id: 'new@example.com' }
          if (command === 'mail.rawMessage') return rawReply?.()
          if (command === 'mail.readAttachment') return { data: 'UERG', mime: 'application/pdf', size: 3 }
          if (command === 'mail.send') return { ok: true }
          return {}
        },
      },
    },
  }
})

afterEach(() => {
  settings$.replyForward.set(DEFAULT_REPLY_FORWARD_PREFS)
  settings$.signaturePlacement.set({})
  delete (window as any).go
})

describe('reply in the full editor', () => {
  it('quotes the original below the cursor with the short header by default, one Re:', () => {
    openThread(original())
    openReplyInFullEditor()

    const compose = draft()
    expect(compose?.subject).toBe('Re: Plan')
    expect(compose?.rich).toBe(false)
    expect(compose?.text).toMatch(/^\n\nOn .+, Ana <Ops> & Co wrote:\n> Line one\n> Line two$/)
    expect(compose?.signature).toEqual({ html: '', text: '', placement: 'aboveQuote' })
  })

  it('keeps the signature with the user part above the quote', () => {
    settings$.signature.set('<p>Me</p>')
    openThread(original())
    openReplyInFullEditor()

    expect(draft()?.text).toMatch(/^\n\nMe\n\nOn .+ wrote:\n> Line one/)
  })

  it('answers an HTML original in HTML, escaped, inside a blockquote', () => {
    openThread(original({ body_html: '<p>Hello <i>you</i></p>' }))
    openReplyInFullEditor()

    const compose = draft()
    expect(compose?.rich).toBe(true)
    expect(compose?.html).toMatch(
      /^<p><\/p><p>On .+, Ana &lt;Ops&gt; &amp; Co wrote:<\/p><blockquote><p>Hello <i>you<\/i><\/p><\/blockquote>$/,
    )
  })

  it('puts the reply below the quote, and keeps carried text and the Outlook header', () => {
    setPrefs({ replyPosition: 'below', headerStyle: 'outlook', collapsePrefixes: false })
    openThread(original())
    compose$.composer.set('Sounds good')
    openReplyInFullEditor()

    const compose = draft()
    expect(compose?.subject).toBe('RE: Re: Plan')
    expect(compose?.text).toStartWith('-----\nFrom: Ana <Ops> & Co <ana@example.com>\nSent: ')
    expect(compose?.text).toContain('\nSubject: RE: Re: Plan\n> Line one\n> Line two\n\nSounds good')
    expect(compose?.signature).toEqual({ html: '', text: '', placement: 'belowText' })
  })

  it('writes a plain reply to an HTML original when the quote style is plain text', () => {
    setPrefs({ quoteStyle: 'plain' })
    openThread(original({ body: '', body_html: '<p>Hello</p><p>World</p>' }))
    openReplyInFullEditor()

    expect(draft()?.rich).toBe(false)
    expect(draft()?.text).toMatch(/wrote:\n> Hello\n> World$/)
  })

  it('leaves the original out when asked, exactly as before', () => {
    setPrefs({ includeOriginal: false })
    openThread(original())
    compose$.composer.set('Just this')
    openReplyInFullEditor()

    expect(draft()?.text).toBe('Just this')
  })

  it('collapses the quick reply subject too', async () => {
    openThread(original())
    compose$.composer.set('ok')
    await sendReply()

    const sent = calls.find((call) => call.command === 'mail.send')?.payload
    expect(sent?.subject).toBe('Re: Plan')
    // The chat-style quick reply never quotes: the conversation shows the original.
    expect(sent?.body).toBe('ok')
  })
})

describe('forward', () => {
  it('writes the forwarded header in the system locale, not the interface language (ADR-0062)', async () => {
    await i18n.changeLanguage('ca')
    try {
      await forwardMessage(original())
      const text = draft()?.text ?? ''
      expect(text).toContain(`Date: ${formatFullTimestamp(DATE, [])}`)
      if (formatFullTimestamp(DATE, 'ca') !== formatFullTimestamp(DATE, [])) {
        expect(text).not.toContain(formatFullTimestamp(DATE, 'ca'))
      }
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('attaches the original as message/rfc822 when forwarding as attachment', async () => {
    setPrefs({ forwardMode: 'attachment' })
    rawReply = () => ({ data: 'RnJvbTogYQ0KDQpi', size: 12, filename: 'Plan.eml' })
    await forwardMessage(original({ subject: 'Fwd: FW: Plan' }))

    const request = calls.find((call) => call.command === 'mail.rawMessage')?.payload
    expect(request).toEqual({
      thread_id: 'acc-1#INBOX#k1',
      message_ids: ['acc-1#INBOX#k1#42'],
      folder: 'INBOX',
      subject: 'Fwd: FW: Plan',
    })
    const compose = draft()
    expect(compose?.subject).toBe('Fwd: Plan')
    expect(compose?.text).toBe('')
    expect(compose?.attachments).toHaveLength(1)
    expect(compose?.attachments[0]).toMatchObject({
      filename: 'Plan.eml',
      mime: 'message/rfc822',
      size: 12,
      data: 'RnJvbTogYQ0KDQpi',
    })
  })

  it('keeps the draft open and says so when the original cannot be fetched', async () => {
    setPrefs({ forwardMode: 'attachment' })
    rawReply = () => {
      throw new Error('offline')
    }
    await forwardMessage(original())

    expect(draft()?.attachments).toEqual([])
    expect(ui$.toast.get()).toContain("Couldn't attach the original message")
    expect(ui$.toastTone.get()).toBe('error')
  })

  it('forwards a message not yet back from the server inline', async () => {
    setPrefs({ forwardMode: 'attachment' })
    await forwardMessage(original({ id: 'sent-1' }))

    expect(calls.some((call) => call.command === 'mail.rawMessage')).toBe(false)
    expect(draft()?.text).toContain('Forwarded message')
  })

  it('copies the original attachments inline unless told not to', async () => {
    const withFile = original({ attachments: [{ filename: 'a.pdf', mime: 'application/pdf', size: 3, key: 'k/a.pdf', url: null }] })
    await forwardMessage(withFile)
    expect(draft()?.attachments.map((a) => a.filename)).toEqual(['a.pdf'])

    compose$.tabs.set([])
    calls.length = 0
    setPrefs({ forwardAttachments: false })
    await forwardMessage(withFile)
    expect(draft()?.attachments).toEqual([])
    expect(calls.some((call) => call.command === 'mail.readAttachment')).toBe(false)
  })
})

// Account → Signature: above or below the quoted original (#277).
describe('signature placement against the quote', () => {
  const ATTRIBUTION = 'On [^\n]+ wrote:\n> Line one\n> Line two'
  const re = (pattern: string) => new RegExp(pattern)
  const withCc = () => original({ cc: 'me@example.com, Bo <bo@example.com>' })
  // A second open in the same test starts from a fresh quick reply, as it
  // does in the app once the thread is opened again.
  const reset = () => {
    compose$.tabs.set([])
    compose$.composer.set('')
    compose$.quickReplySignature.set(null)
  }
  const switchTo = (accountId: string) => updateComposeDraft(compose$.tabs.get()[0].id, { accountId })

  beforeEach(() => settings$.signature.set('<p>Me</p>'))

  it('keeps the signature with the reply by default, and above the quote when asked (reply)', () => {
    for (const choice of ['withText', 'above'] as const) {
      reset()
      setSignaturePlacement('acc-1', choice)
      openThread(original())
      openReplyInFullEditor()
      expect(draft()?.text).toMatch(re(`^\n\nMe\n\n${ATTRIBUTION}$`))
      expect(draft()?.signature).toEqual({ html: '<p>Me</p>', text: 'Me', placement: 'aboveQuote' })
    }
  })

  it('puts the signature below the quote when asked (reply)', () => {
    setSignaturePlacement('acc-1', 'below')
    openThread(original())
    openReplyInFullEditor()
    expect(draft()?.text).toMatch(re(`^\n\n${ATTRIBUTION}\n\nMe$`))
    expect(draft()?.signature).toEqual({ html: '<p>Me</p>', text: 'Me', placement: 'belowText' })
  })

  it('places it above or below the quote in a reply all, with text carried over', () => {
    setSignaturePlacement('acc-1', 'above')
    openThread(withCc())
    compose$.composer.set('Sounds good')
    openReplyInFullEditor()
    expect(draft()?.cc).toBe('Bo <bo@example.com>')
    expect(draft()?.text).toMatch(re(`^Sounds good\n\nMe\n\n${ATTRIBUTION}$`))

    reset()
    setSignaturePlacement('acc-1', 'below')
    openThread(withCc())
    compose$.composer.set('Sounds good')
    openReplyInFullEditor()
    expect(draft()?.cc).toBe('Bo <bo@example.com>')
    expect(draft()?.text).toMatch(re(`^Sounds good\n\n${ATTRIBUTION}\n\nMe$`))
    expect(draft()?.signature?.placement).toBe('belowText')
  })

  it('moves the signature above the quote of a reply written below it, only when asked', () => {
    setPrefs({ replyPosition: 'below' })
    openThread(original())
    compose$.composer.set('Sounds good')
    openReplyInFullEditor()
    // By default it stays with the text, under the quote.
    expect(draft()?.text).toMatch(re(`^${ATTRIBUTION}\n\nSounds good\n\nMe$`))

    reset()
    setSignaturePlacement('acc-1', 'above')
    openThread(original())
    compose$.composer.set('Sounds good')
    openReplyInFullEditor()
    expect(draft()?.text).toMatch(re(`^\n\nMe\n\n${ATTRIBUTION}\n\nSounds good$`))
    expect(draft()?.signature?.placement).toBe('aboveQuote')
  })

  it('places it above or below the quote of an HTML reply', () => {
    const html = original({ body_html: '<p>Hello</p>' })
    setSignaturePlacement('acc-1', 'below')
    openThread(html)
    openReplyInFullEditor()
    expect(draft()?.rich).toBe(true)
    expect(draft()?.html).toMatch(
      /^<p><\/p><p>On .+ wrote:<\/p><blockquote><p>Hello<\/p><\/blockquote><p><\/p><p>Me<\/p>$/,
    )

    reset()
    setPrefs({ replyPosition: 'below' })
    setSignaturePlacement('acc-1', 'above')
    openThread(html)
    openReplyInFullEditor()
    expect(draft()?.html).toMatch(/^<p><\/p><p>Me<\/p><p>On .+ wrote:<\/p><blockquote><p>Hello<\/p><\/blockquote>/)
    expect(draft()?.signature?.placement).toBe('aboveQuote')
  })

  it('puts it above the forwarded message by default and below it when asked (forward)', async () => {
    await forwardMessage(original())
    expect(draft()?.text).toStartWith('\n\nMe\n\n')
    expect(draft()?.text).toContain('Line one\nLine two')
    expect(draft()?.signature?.placement).toBe('aboveQuote')

    reset()
    setSignaturePlacement('acc-1', 'above')
    await forwardMessage(original())
    expect(draft()?.text).toStartWith('\n\nMe\n\n')
    expect(draft()?.signature?.placement).toBe('aboveQuote')

    reset()
    setSignaturePlacement('acc-1', 'below')
    await forwardMessage(original())
    expect(draft()?.text).toEndWith('Line two\n\nMe')
    expect(draft()?.signature?.placement).toBe('belowText')

    reset()
    await forwardMessage(original({ body_html: '<p>Hello</p>' }))
    expect(draft()?.html).toEndWith('<p>Hello</p></div><p></p><p>Me</p>')
  })

  it('swaps the signature in its place when the draft changes account', async () => {
    const two = { ...account, id: 'acc-2', email: 'two@example.com' }
    accounts$.set([account, { ...two, signature: { mode: 'custom' as const, html: '<p>Two</p>' } }])
    setSignaturePlacement('acc-1', 'below')
    await forwardMessage(original())
    switchTo('acc-2')
    expect(draft()?.text).toEndWith('Line two\n\nTwo')
    expect(draft()?.text).not.toMatch(/^Me$/m)

    reset()
    setPrefs({ replyPosition: 'below' })
    setSignaturePlacement('acc-1', 'above')
    openThread(original())
    compose$.composer.set('Sounds good')
    openReplyInFullEditor()
    switchTo('acc-2')
    expect(draft()?.text).toMatch(re(`^\n\nTwo\n\n${ATTRIBUTION}\n\nSounds good$`))
  })

  it('leaves new messages, other accounts and replies without the original as they were', () => {
    setSignaturePlacement('acc-1', 'below')
    openComposeTab({ accountId: 'acc-1' })
    expect(draft()?.text).toBe('\n\nMe')
    expect(draft()?.signature?.placement).toBe('belowText')

    reset()
    setPrefs({ includeOriginal: false })
    openThread(original())
    compose$.composer.set('Just this')
    openReplyInFullEditor()
    expect(draft()?.text).toBe('Just this\n\nMe')

    reset()
    setPrefs({})
    setSignaturePlacement('acc-1', 'withText')
    setSignaturePlacement('other', 'below')
    openThread(original())
    openReplyInFullEditor()
    expect(draft()?.text).toMatch(re(`^\n\nMe\n\n${ATTRIBUTION}$`))
  })
})

describe('signature placement preference (#277)', () => {
  it('is kept per account, removed when it goes back to the default, and read back without junk', () => {
    setSignaturePlacement('acc-1', 'below')
    setSignaturePlacement('acc-2', 'above')
    expect(signaturePlacementFor('acc-1')).toBe('below')
    expect(signaturePlacementFor('acc-3')).toBe('withText')
    expect(signaturePlacementFor(undefined)).toBe('withText')
    setSignaturePlacement('acc-1', 'withText')
    expect(settings$.signaturePlacement.get()).toEqual({ 'acc-2': 'above' })
    expect(calls.filter((call) => call.command === 'app.prefsSet').at(-1)?.payload).toEqual({
      key: 'signature_placement',
      value: { 'acc-2': 'above' },
    })
    expect(sanitizeSignaturePlacements({ a: 'above', b: 'sideways', '': 'below', c: 3 })).toEqual({ a: 'above' })
    expect(sanitizeSignaturePlacements('{"a":"below"}')).toEqual({ a: 'below' })
    expect(sanitizeSignaturePlacements('not json')).toEqual({})
    expect(sanitizeSignaturePlacements(['above'])).toEqual({})
    expect(signaturePlacementFor('constructor')).toBe('withText')
  })

  it('is read back at startup, and a row that was not read keeps what is held', () => {
    hydrateSettings({ signature_placement: { 'acc-1': 'below', 'acc-2': 'sideways' } }, { languageRead: false })
    expect(settings$.signaturePlacement.get()).toEqual({ 'acc-1': 'below' })
    hydrateSettings({}, { languageRead: false })
    expect(settings$.signaturePlacement.get()).toEqual({ 'acc-1': 'below' })
  })
})
