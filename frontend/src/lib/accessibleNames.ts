// Finding controls a screen reader would announce as nothing.
//
// A button whose only content is an icon has no accessible name unless it is
// given one. To someone using Orca or VoiceOver that button is announced as
// "button", which is the same as not being there — and it is the failure that
// is hardest to notice by looking, because on screen the icon is perfectly
// clear.
//
// Kept as source analysis rather than a rendering test so it covers every
// component, including the ones no test renders.

/** Where a control with no name was found. */
export type UnnamedControl = { file: string; line: number; snippet: string }

const NAMING_ATTRIBUTES = ['aria-label', 'aria-labelledby', 'title']

/**
 * Whether a `<button>` opening tag already carries a name.
 *
 * `aria-hidden` counts too: a control hidden from the accessibility tree is
 * not announced at all, which is right for a decorative one and is a
 * deliberate statement rather than an omission.
 */
function tagIsNamed(tag: string): boolean {
  return NAMING_ATTRIBUTES.some((attribute) => tag.includes(`${attribute}=`)) || tag.includes('aria-hidden')
}

/**
 * Whether the body of a control contains something a reader would hear.
 *
 * Text, a translated string, or `{children}` — a component that takes its
 * label from its caller is named by whoever uses it, not here.
 */
function bodyHasText(body: string): boolean {
  // A translated string anywhere in the body, however it is reached — the
  // common shape is `{busy ? t('a') : t('b')}`, which a stricter test that
  // demanded `{t(` at the start would miss and then report as unnamed.
  if (/\bt\(/.test(body)) return true
  // A value passed in: `{children}`, `{label}`, `{day}`. Whoever supplies it
  // names the control, and this file cannot see that far.
  if (/\{\s*[A-Za-z_$][\w$.]*\s*\}/.test(body)) return true
  // A call whose result is rendered: `{translate('common.change')}`,
  // `{date.getDate()}`. Almost always a label, and treating it as one is the
  // conservative reading — a check that guessed the other way would report
  // named controls and be switched off.
  if (/\{[^{}]*[A-Za-z_$][\w$.]*\([^{}]*\)[^{}]*\}/.test(body)) return true
  // Bare words between tags, ignoring anything inside a JSX expression.
  const withoutExpressions = body.replace(/\{[^{}]*\}/g, '')
  return /(^|>)[^<>]*[A-Za-z]{2,}[^<>]*(<|$)/.test(withoutExpressions)
}

/**
 * Every icon-only button in a file that nothing would announce.
 *
 * Deliberately conservative: anything it cannot read confidently is left
 * alone. A check that cried wolf would be turned off, and then it would be
 * catching nothing at all.
 */
/**
 * Where a JSX opening tag ends, counting braces.
 *
 * A regex cannot do this: `title={count > 0 ? a : b}` contains a `>` that
 * belongs to the expression, not to the tag, and stopping there reads a named
 * button as an unnamed one — which is the worst way for a check like this to
 * fail, because it produces noise and gets switched off.
 */
function endOfTag(source: string, from: number): { end: number; selfClosing: boolean } | null {
  let depth = 0
  for (let index = from; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === '>' && depth === 0) {
      return { end: index + 1, selfClosing: source[index - 1] === '/' }
    }
  }
  return null
}

export function findUnnamedControls(file: string, source: string): UnnamedControl[] {
  const found: UnnamedControl[] = []
  const opening = /<button\b/g
  let match: RegExpExecArray | null

  while ((match = opening.exec(source))) {
    const tagEnd = endOfTag(source, match.index)
    if (!tagEnd) continue
    const tag = source.slice(match.index, tagEnd.end)
    opening.lastIndex = tagEnd.end
    if (tagIsNamed(tag)) continue

    // A self-closing button has no body at all, so it can only be named by an
    // attribute — and this one was not.
    let body = ''
    if (!tagEnd.selfClosing) {
      const close = source.indexOf('</button>', tagEnd.end)
      if (close === -1) continue
      body = source.slice(tagEnd.end, close)
      // Nested buttons belong to their own check, not this one.
      if (body.includes('<button')) continue
    }
    if (bodyHasText(body)) continue

    found.push({
      file,
      line: source.slice(0, match.index).split('\n').length,
      snippet: tag.replace(/\s+/g, ' ').slice(0, 80),
    })
  }
  return found
}
