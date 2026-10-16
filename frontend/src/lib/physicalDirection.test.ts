import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { baseUtility, findPhysicalDirection, isPhysicalUtility } from './physicalDirection'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : []
  })
}

/**
 * The places that keep a physical side on purpose, each with its reason. A new
 * entry is a decision, not a way to quiet the check: say why the side must not
 * mirror in right to left (ADR-0061).
 */
const ALLOWED: { file: string; token: string; reason: string }[] = [
  ...['left-1.5', 'right-1.5'].map((token) => ({
    file: 'src/components/composer/composerImage.tsx',
    token,
    reason:
      'Image resize handles sit on physical corners: their names say "top left" and the drag arithmetic is in screen pixels.',
  })),
  ...['border-left:', 'padding-left:'].map((token) => ({
    file: 'src/components/composer/composerHelpers.ts',
    token,
    reason:
      'Inline style of the quote in outgoing mail: mail clients (Outlook among them) do not support logical properties.',
  })),
]

const allowed = (file: string, token: string) =>
  ALLOWED.some((entry) => entry.file === file && entry.token === token)

describe('physical left/right in component source (ADR-0061)', () => {
  it('flags margins, paddings, positions, borders, corners and alignment by side', () => {
    for (const token of [
      'ml-2',
      'mr-auto',
      'pl-3',
      'pr-[10px]',
      'left-0',
      '-right-1',
      'right-2.5',
      'border-l',
      'border-r-2',
      'border-l-transparent',
      'rounded-r',
      'rounded-tl-sm',
      'rounded-br-[4px]',
      'text-left',
      'text-right',
      'float-right',
      'origin-top-left',
      'translate-x-4',
      'hover:ml-1',
      'max-[600px]:pl-2',
      '!pr-0',
      'scroll-ml-4',
    ]) {
      expect(isPhysicalUtility(token)).toBe(true)
    }
  })

  it('leaves logical utilities and direction-neutral ones alone', () => {
    for (const token of [
      'ms-2',
      'me-auto',
      'ps-3',
      'pe-[10px]',
      'start-0',
      '-end-1',
      'inset-x-0',
      'border-s',
      'border-e-2',
      'rounded-s',
      'rounded-se-sm',
      'text-start',
      'text-end',
      'text-center',
      'mx-auto',
      'px-2',
      'left-1/2',
      '-translate-x-1/2',
      'translate-y-1',
      'right-click',
      'left',
      'border-b',
      'rounded-lg',
      'pl',
    ]) {
      expect(isPhysicalUtility(token)).toBe(false)
    }
  })

  it('reads the utility behind variants, important and negative markers', () => {
    expect(baseUtility('max-[600px]:hover:-ml-2')).toBe('ml-2')
    expect(baseUtility('[&>svg]:!pl-1')).toBe('pl-1')
  })

  it('finds classes in strings and templates, and physical sides in styles', () => {
    const source = [
      "const a = 'flex ml-2'",
      'const b = `px-2 ${on ? "right-0" : "end-0"}`',
      '<div style={{ marginLeft: 4, textAlign: "right" }} />',
      '// a comment about ml-2 is not a class',
      "const c = 'ms-2 text-start'",
    ].join('\n')
    expect(findPhysicalDirection('x.tsx', source).map((f) => `${f.line} ${f.token}`)).toEqual([
      '1 ml-2',
      '2 right-0',
      '3 marginLeft:',
      '3 textAlign: "right"',
    ])
  })

  it('accepts a physical class stated for both directions on its line', () => {
    expect(findPhysicalDirection('x.tsx', "'translate-x-4 rtl:-translate-x-4'")).toEqual([])
    expect(findPhysicalDirection('x.tsx', "'rtl:space-x-reverse ltr:ml-2'")).toEqual([])
    // A counterpart for a different utility does not count.
    expect(findPhysicalDirection('x.tsx', "'translate-x-4 rtl:-me-1'")).toHaveLength(1)
  })

  // The check itself, over the whole interface. This is the assertion that
  // keeps the mirror whole: a new `ml-2` fails here instead of shipping.
  it('finds none in the interface outside the justified exceptions', () => {
    const files = [...walk('src/components'), 'src/App.tsx']
    const offenders = files
      .flatMap((file) => findPhysicalDirection(file.replace(/\\/g, '/'), readFileSync(file, 'utf8')))
      .filter((found) => !allowed(found.file, found.token))
    expect(offenders.map((one) => `${one.file}:${one.line}  ${one.token}`).join('\n')).toBe('')
  })

  it('has no stale exception', () => {
    for (const entry of ALLOWED) {
      const found = findPhysicalDirection(entry.file, readFileSync(entry.file, 'utf8'))
      expect(found.some((one) => one.token === entry.token)).toBe(true)
    }
  })
})
