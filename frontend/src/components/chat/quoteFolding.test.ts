import { describe, expect, it } from 'bun:test'
import { applyHtmlFolds, foldHtml, revealFoldsAround, splitPlainText } from './quoteFolding'

const BOTH = { quotes: true, signatures: true }
const QUOTES = { quotes: true, signatures: false }

function fold(html: string, options = BOTH) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const count = applyHtmlFolds(doc, options)
  const folds = Array.from(doc.querySelectorAll('details.oreneta-fold')) as HTMLDetailsElement[]
  // What a reader sees with every fold closed.
  const clone = doc.body.cloneNode(true) as HTMLElement
  clone.querySelectorAll('details.oreneta-fold').forEach((el) => el.remove())
  return { doc, count, folds, visible: clone.textContent!.replace(/\s+/g, ' ').trim() }
}

// ─── HTML corpus: the markup each client actually sends ───

const GMAIL_REPLY = `<div dir="ltr">Sounds good, see you Thursday.<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr">Ana Ruiz<div>Operations</div></div></div></div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, Oct 12, 2026 at 10:02 AM Ben Ode &lt;ben@example.test&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Does Thursday work for the review?</div></blockquote></div>`

const GMAIL_FORWARD = `<div dir="ltr">FYI, see below.<br><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Ben Ode</strong> <span dir="auto">&lt;ben@example.test&gt;</span><br>Date: Mon, Oct 12, 2026 at 10:02 AM<br>Subject: Invoice<br></div><br><br><div dir="ltr">The invoice is attached.</div></div></div>`

const OUTLOOK_WEB = `<html><body><div class="elementToProof" style="font-family:Aptos">Approved — go ahead.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt"><b>From:</b> Ben Ode &lt;ben@example.test&gt;<br><b>Sent:</b> Monday, October 12, 2026 10:02<br><b>To:</b> Ana Ruiz<br><b>Subject:</b> RE: Budget</font><div>&nbsp;</div></div><div dir="ltr">Can you approve the budget?</div></body></html>`

const OUTLOOK_WEB_FORWARD = OUTLOOK_WEB.replace('RE: Budget', 'FW: Budget')

const OUTLOOK_DESKTOP = `<html><body lang="EN-US"><div class="WordSection1"><p class="MsoNormal">Thanks, received.<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Ben Ode &lt;ben@example.test&gt;<br><b>Sent:</b> Monday, October 12, 2026 10:02 AM<br><b>To:</b> Ana Ruiz<br><b>Subject:</b> Report</p></div></div><p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Here is the quarterly report.<o:p></o:p></p></div></body></html>`

const APPLE_MAIL = `<html><body dir="auto"><div>Works for me.</div><div><br></div><div><br><blockquote type="cite"><div>On 12 Oct 2026, at 10:02, Ben Ode &lt;ben@example.test&gt; wrote:</div><br class="Apple-interchange-newline"><div><div>Lunch at noon?</div></div></blockquote></div><br></body></html>`

const APPLE_FORWARD = `<html><body dir="auto"><div>Look at this.</div><div><br><div>Begin forwarded message:</div><br class="Apple-interchange-newline"><blockquote type="cite"><div><b>From: </b>Ben Ode</div><div><b>Subject: </b>Plans</div><div>The plans are attached.</div></blockquote></div></body></html>`

const THUNDERBIRD = `<html><body><p>Merged, thanks.</p><div class="moz-signature">-- <br>Ana Ruiz</div><div class="moz-cite-prefix">On 12/10/2026 10:02, Ben Ode wrote:<br></div><blockquote type="cite" cite="mid:abc@example.test"><p>Could you merge the branch?</p><blockquote type="cite"><p>Earlier nested history.</p></blockquote></blockquote></body></html>`

const THUNDERBIRD_INLINE = `<html><body><div class="moz-cite-prefix">On 12/10/2026 10:02, Ben Ode wrote:<br></div><blockquote type="cite"><p>Can you do Friday?</p></blockquote><p>Yes, Friday is fine.</p><blockquote type="cite"><p>And bring the slides?</p></blockquote><p>Will do.</p></body></html>`

// A forwarded table and a pull-quote look like quotes but are the content.
const LOOKALIKE = `<html><body><p>Numbers for the week:</p><blockquote style="margin-left:2em"><table><tr><td>Mon</td><td>12</td></tr><tr><td>Tue</td><td>15</td></tr></table></blockquote><p>As the poet said:</p><blockquote>Hope is the thing with feathers</blockquote></body></html>`

const ONLY_QUOTE = `<html><body><div class="moz-cite-prefix">On 12/10/2026 10:02, Ben Ode wrote:<br></div><blockquote type="cite"><p>Original text with no reply above it.</p></blockquote></body></html>`

describe('HTML quote folding', () => {
  it('folds a Gmail reply quote and its signature, keeping the reply', () => {
    const { count, folds, visible } = fold(GMAIL_REPLY)
    expect(count).toBe(2)
    expect(folds.map((el) => el.dataset.orenetaFold)).toEqual(['signature', 'quote'])
    expect(visible).toBe('Sounds good, see you Thursday.')
    expect(folds[1].textContent).toContain('Does Thursday work')
    expect(folds[1].textContent).toContain('wrote:')
    expect(folds[0].textContent).toContain('-- ')
    expect(folds.every((el) => !el.open)).toBe(true)
  })

  it('folds only the quote when signatures are left alone', () => {
    const { folds } = fold(GMAIL_REPLY, QUOTES)
    expect(folds.map((el) => el.dataset.orenetaFold)).toEqual(['quote'])
  })

  it('leaves a Gmail forward open', () => {
    expect(fold(GMAIL_FORWARD).count).toBe(0)
  })

  it('folds the Outlook on the web divider through the end of the message', () => {
    const { folds, visible, doc } = fold(OUTLOOK_WEB)
    expect(folds).toHaveLength(1)
    expect(folds[0].querySelector('#appendonsend')).not.toBeNull()
    expect(folds[0].querySelector('hr')).not.toBeNull()
    expect(folds[0].textContent).toContain('Can you approve the budget?')
    expect(visible.startsWith('Approved — go ahead.')).toBe(true)
    expect(doc.body.querySelector(':scope > hr')).toBeNull()
  })

  it('leaves an Outlook forward open', () => {
    expect(fold(OUTLOOK_WEB_FORWARD).count).toBe(0)
  })

  it('folds the Outlook desktop header block and the message after it', () => {
    const { folds, visible } = fold(OUTLOOK_DESKTOP)
    expect(folds).toHaveLength(1)
    expect(folds[0].textContent).toContain('Sent:')
    expect(folds[0].textContent).toContain('Here is the quarterly report.')
    expect(visible).toContain('Thanks, received.')
    expect(visible).not.toContain('quarterly')
  })

  it('folds an Apple Mail cite blockquote', () => {
    const { folds, visible } = fold(APPLE_MAIL)
    expect(folds).toHaveLength(1)
    expect(folds[0].textContent).toContain('Lunch at noon?')
    expect(visible).toContain('Works for me.')
  })

  it('leaves an Apple Mail forward open', () => {
    expect(fold(APPLE_FORWARD).count).toBe(0)
  })

  it('folds Thunderbird history as one fold, attribution included, nested quotes inside', () => {
    const { folds, visible } = fold(THUNDERBIRD, QUOTES)
    expect(folds).toHaveLength(1)
    expect(folds[0].querySelector('.moz-cite-prefix')).not.toBeNull()
    expect(folds[0].querySelectorAll('blockquote')).toHaveLength(2)
    expect(visible).toContain('Merged, thanks.')
    expect(visible).toContain('Ana Ruiz')
  })

  it('folds the Thunderbird signature when asked', () => {
    const { folds } = fold(THUNDERBIRD)
    expect(folds.map((el) => el.dataset.orenetaFold)).toEqual(['signature', 'quote'])
  })

  it('does not fold an inline (interleaved) reply', () => {
    expect(fold(THUNDERBIRD_INLINE).count).toBe(0)
  })

  it('does not fold content that only looks like a quote', () => {
    expect(fold(LOOKALIKE).count).toBe(0)
  })

  it('never folds a message down to nothing', () => {
    expect(fold(ONLY_QUOTE).count).toBe(0)
    const onlySignature = '<div class="gmail_signature">Ana Ruiz</div>'
    expect(fold(onlySignature).count).toBe(0)
  })

  it('folds nothing when both options are off, and is idempotent', () => {
    expect(fold(GMAIL_REPLY, { quotes: false, signatures: false }).count).toBe(0)
    const once = foldHtml(GMAIL_REPLY, BOTH)
    expect(foldHtml(once, BOTH)).toBe(once)
  })

  it('opens the folds around a node', () => {
    const { doc, folds } = fold(THUNDERBIRD)
    const nested = doc.querySelector('blockquote blockquote p')!
    revealFoldsAround(nested.firstChild)
    expect(folds[1].open).toBe(true)
    expect(folds[0].open).toBe(false)
  })

  it('carries the labels it is given and adds no remote references', () => {
    const html = foldHtml(APPLE_MAIL, BOTH, {
      showQuoted: 'Mostrar texto citado',
      hideQuoted: 'Ocultar texto citado',
      showSignature: 'Mostrar firma',
      hideSignature: 'Ocultar firma',
    })
    expect(html).toContain('Mostrar texto citado')
    expect(html).not.toMatch(/https?:/)
    expect(html).not.toContain('<script')
  })
})

describe('plain-text quote folding', () => {
  const kinds = (text: string, options = BOTH) => splitPlainText(text, options).map((s) => s.kind)

  it('folds a trailing ">" quote with its attribution', () => {
    const text = 'Sounds good.\n\nOn Mon, Oct 12, 2026 at 10:02 AM Ben Ode <ben@example.test> wrote:\n> Thursday?\n> Let me know.\n'
    const segments = splitPlainText(text, BOTH)
    expect(segments.map((s) => s.kind)).toEqual(['body', 'quote'])
    expect(segments[0].text.trim()).toBe('Sounds good.')
    expect(segments[1].text.startsWith('On Mon')).toBe(true)
    expect(segments.map((s) => s.text).join('\n')).toBe(text)
  })

  it('folds an attribution wrapped over two lines', () => {
    const text = 'Yes.\n\nOn Mon, Oct 12, 2026 at 10:02 AM Ben Ode <\nben@example.test> wrote:\n\n> Ok?'
    const segments = splitPlainText(text, BOTH)
    expect(segments[1].text.startsWith('On Mon')).toBe(true)
  })

  it('folds nested quotes as one block', () => {
    const text = 'Agreed.\n\nEl lun, 12 oct 2026, Ben escribió:\n> Sure\n>\n> > Original idea\n> > second line'
    expect(kinds(text)).toEqual(['body', 'quote'])
  })

  it('folds the signature and the quote separately', () => {
    const text = 'See you then.\n\n-- \nAna Ruiz\nOperations\n\nOn Mon, Ben wrote:\n> Lunch?'
    const segments = splitPlainText(text, BOTH)
    expect(segments.map((s) => s.kind)).toEqual(['body', 'signature', 'quote'])
    expect(segments[1].text).toBe('-- \nAna Ruiz\nOperations\n')
    expect(kinds(text, QUOTES)).toEqual(['body', 'quote'])
  })

  it('folds an Outlook plain-text header block', () => {
    const text = 'Approved.\n\n________________________________\nFrom: Ben Ode <ben@example.test>\nSent: Monday, October 12, 2026 10:02\nTo: Ana Ruiz\nSubject: RE: Budget\n\nCan you approve?'
    const segments = splitPlainText(text, BOTH)
    expect(segments.map((s) => s.kind)).toEqual(['body', 'quote'])
    expect(segments[1].text).toContain('Can you approve?')
  })

  it('folds "-----Original Message-----"', () => {
    expect(kinds('Done.\n\n-----Original Message-----\nFrom: Ben\nSent: today\n\nPlease do it.')).toEqual([
      'body',
      'quote',
    ])
  })

  it('leaves forwards, inline replies, lone ">" lines and quote-only messages open', () => {
    const forward = 'FYI\n\n________________________________\nFrom: Ben\nSent: today\nSubject: FW: Plans\n\nThe plans.'
    expect(kinds(forward)).toEqual(['body'])
    const fwdGmail = 'FYI\n\n---------- Forwarded message ---------\nFrom: Ben\nDate: today\nSubject: Plans\n\nThe plans.'
    expect(kinds(fwdGmail)).toEqual(['body'])
    const inline = 'On Mon, Ben wrote:\n> Friday?\nYes.\n> Slides?\nSure.'
    expect(kinds(inline)).toEqual(['body'])
    expect(kinds('Compare these:\n> 5 is more than 3')).toEqual(['body'])
    expect(kinds('On Mon, Ben wrote:\n> Only the quote here.\n> Nothing else.')).toEqual(['body'])
    expect(kinds('-- \nAna Ruiz')).toEqual(['body'])
  })

  it('does not treat a long "--" section as a signature', () => {
    const long = `Intro\n--\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}`
    expect(kinds(long)).toEqual(['body'])
  })
})
