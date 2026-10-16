// Finds physical left/right layout in component source (ADR-0061). The
// interface mirrors for right-to-left languages by using logical utilities
// (ms/me, ps/pe, start/end, border-s/e, rounded-s/e, text-start/end) and
// logical CSS properties; a physical `ml-2` or `left-0` stays on the left in
// Arabic and quietly breaks the mirror. The guard test runs this over every
// component, so a new physical class fails CI instead of shipping.

export type PhysicalFinding = { file: string; line: number; token: string }

const SIZE = String.raw`(?:\d+(?:\.\d+)?|px|full|auto|\d+/\d+|\[[^\]\s]+\]|\([^)\s]+\))`
const RADIUS = String.raw`(?:none|xs|sm|md|lg|xl|2xl|3xl|4xl|full|\[[^\]\s]+\]|\([^)\s]+\))`
const COLOR_OR_WIDTH = String.raw`[a-z0-9./#%_()\[\]-]+`

// One utility, variants and important/negative markers already stripped.
const PHYSICAL_UTILITY = new RegExp(
  '^(?:' +
    [
      `(?:m|p|scroll-m|scroll-p)[lr]-${SIZE}`,
      `(?:left|right)-${SIZE}`,
      `border-[lr](?:-${COLOR_OR_WIDTH})?`,
      `rounded-(?:[lr]|[tb][lr])(?:-${RADIUS})?`,
      'text-(?:left|right)',
      '(?:float|clear)-(?:left|right)',
      'origin-(?:(?:top|bottom)-)?(?:left|right)',
      `translate-x-${SIZE}`,
    ].join('|') +
    ')$',
)

// Centring with `left-1/2 -translate-x-1/2` lands on the same spot in either
// direction, so it is not a physical placement.
const DIRECTION_NEUTRAL = new Set(['left-1/2', 'right-1/2', 'translate-x-1/2'])

// Inline styles written with physical sides. `left`/`top` coordinates taken
// from a pointer or a rect are physical by nature and are not flagged here;
// margins, paddings, borders and alignment have logical equivalents.
const PHYSICAL_STYLE =
  /\b(?:margin|padding|border)(?:Left|Right)\w*\s*:|\btextAlign\s*:\s*['"](?:left|right)['"]|\b(?:margin|padding|border)-(?:left|right)\s*:|\btext-align\s*:\s*(?:left|right)\b/g

/** The utility a class token applies, without variants, `!` or a leading `-`. */
export function baseUtility(token: string): string {
  let depth = 0
  let start = 0
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]
    if (ch === '[' || ch === '(') depth++
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ':' && depth === 0) start = i + 1
  }
  return token
    .slice(start)
    .replace(/^!/, '')
    .replace(/!$/, '')
    .replace(/^-/, '')
}

export function isPhysicalUtility(token: string): boolean {
  const utility = baseUtility(token)
  if (DIRECTION_NEUTRAL.has(utility)) return false
  return PHYSICAL_UTILITY.test(utility)
}

/** True for a class applied only in one direction (`rtl:…`, `ltr:…`). */
function isDirectionVariant(token: string): boolean {
  return /(^|:)(rtl|ltr):/.test(token)
}

/** The utility without its value: `translate-x` for `-translate-x-4.5`. */
function utilityFamily(token: string): string {
  return baseUtility(token).replace(/-(?:\d+(?:\.\d+)?|px|full|auto|\d+\/\d+|\[[^\]]*\]|\([^)]*\))$/, '')
}

const ALWAYS_SPLITS = new Set([' ', '\t', '\r', '"', "'", '`', '{', '}', ';'])

/**
 * The class-like tokens of one line. Whitespace, quotes, template braces and
 * semicolons always end a token; commas and `$` only outside brackets, so an
 * arbitrary value such as `pl-[clamp(1px,2px,3px)]` or `ml-(--gap)` stays
 * one token. Unbalanced parentheses at either end (`cn(`, `x)`) are dropped.
 */
export function classTokens(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let square = 0
  let round = 0
  const flush = () => {
    let token = current
    const count = (ch: string) => token.split(ch).length - 1
    while (token.startsWith('(') && count('(') > count(')')) token = token.slice(1)
    while (token.endsWith(')') && count(')') > count('(')) token = token.slice(0, -1)
    if (token) tokens.push(token)
    current = ''
    square = 0
    round = 0
  }
  for (const ch of text) {
    if (ALWAYS_SPLITS.has(ch) || ((ch === ',' || ch === '$') && square === 0 && round === 0)) {
      flush()
      continue
    }
    if (ch === '[') square++
    else if (ch === ']') square = Math.max(0, square - 1)
    else if (ch === '(') round++
    else if (ch === ')') round = Math.max(0, round - 1)
    current += ch
  }
  flush()
  return tokens
}

/**
 * Physical classes and inline-style sides in one source file. Tokens are read
 * from the raw text (see classTokens), which covers className strings,
 * `cn(...)` arguments and style constants alike; comments, JSX comments
 * included, are skipped. A physical class paired on the same line with an
 * `rtl:` (or `ltr:`) counterpart of the same utility states both directions
 * and passes, as does any class behind those variants.
 *
 * Not scanned (ADR-0061): inline `left`/`right` coordinates and transforms in
 * style objects (pointer and rect positions are physical by nature), and
 * `src/lib` and `index.css`, which are reviewed by hand.
 */
export function findPhysicalDirection(file: string, source: string): PhysicalFinding[] {
  const findings: PhysicalFinding[] = []
  let inComment = false
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim()
    if (inComment) {
      if (trimmed.includes('*/')) inComment = false
      return
    }
    const opens = trimmed.lastIndexOf('/*')
    if (opens >= 0 && trimmed.indexOf('*/', opens) < 0) inComment = true
    if (/^(\/\/|\*|\/\*|\{\s*\/\*)/.test(trimmed)) return
    const tokens = classTokens(text)
    const paired = new Set(tokens.filter(isDirectionVariant).map(utilityFamily))
    for (const token of tokens) {
      if (!isPhysicalUtility(token) || isDirectionVariant(token) || paired.has(utilityFamily(token))) continue
      findings.push({ file, line: index + 1, token })
    }
    for (const match of text.matchAll(PHYSICAL_STYLE)) {
      findings.push({ file, line: index + 1, token: match[0].trim() })
    }
  })
  return findings
}
