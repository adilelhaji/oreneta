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

/**
 * Physical classes and inline-style sides in one source file. Tokens are read
 * from the raw text (split at whitespace, quotes and template braces), which
 * covers className strings, `cn(...)` arguments and style constants alike.
 * A physical class paired on the same line with an `rtl:` (or `ltr:`)
 * counterpart of the same utility states both directions and passes, as does
 * any class behind those variants.
 */
export function findPhysicalDirection(file: string, source: string): PhysicalFinding[] {
  const findings: PhysicalFinding[] = []
  const lines = source.split('\n')
  lines.forEach((text, index) => {
    const trimmed = text.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    const tokens = text
      .split(/[\s"'`{}$,;]+/)
      .map((raw) => raw.replace(/^[(]+/, '').replace(/[)]+$/, ''))
      .filter(Boolean)
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
