import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findUnnamedControls } from './accessibleNames'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : []
  })
}

describe('finding controls a screen reader would announce as nothing', () => {
  it('flags an icon-only button with no name', () => {
    const found = findUnnamedControls(
      'x.tsx',
      '<button onClick={go}>\n  <Star size={13} />\n</button>',
    )
    expect(found).toHaveLength(1)
    expect(found[0].line).toBe(1)
  })

  it('accepts every ordinary way of naming one', () => {
    for (const source of [
      '<button aria-label="Star">\n  <Star />\n</button>',
      '<button title="Star">\n  <Star />\n</button>',
      '<button aria-labelledby="x">\n  <Star />\n</button>',
      // Hidden from the tree is a statement, not an omission.
      '<button aria-hidden="true">\n  <Star />\n</button>',
      '<button onClick={go}>Star</button>',
      '<button onClick={go}>{t(\'chat.star\')}</button>',
      // A component named by its caller is named by whoever uses it.
      '<button onClick={go}>{children}</button>',
      '<button onClick={go}>{label}</button>',
    ]) {
      expect(findUnnamedControls('x.tsx', source)).toEqual([])
    }
  })

  it('reads a name whose value contains a comparison', () => {
    // `title={count > 0 ? a : b}` has a `>` that belongs to the expression,
    // not to the tag. Stopping there reads a named button as an unnamed one —
    // the worst way for a check like this to fail, because it produces noise
    // and then gets switched off.
    expect(
      findUnnamedControls('x.tsx', "<button title={n > 0 ? t('a') : t('b')}>\n  <Star />\n</button>"),
    ).toEqual([])
  })

  it('reads a translated string wherever it sits in the body', () => {
    // The common shape. A stricter test that demanded `{t(` at the very start
    // would report every one of these as unnamed.
    expect(
      findUnnamedControls('x.tsx', "<button>\n  <Icon />\n  {busy ? t('a') : t('b')}\n</button>"),
    ).toEqual([])
  })

  it('reads a rendered call as the label it almost always is', () => {
    for (const body of ['{translate(\'common.change\')}', '{date.getDate()}']) {
      expect(findUnnamedControls('x.tsx', `<button>${body}</button>`)).toEqual([])
    }
  })

  it('does not read the icon size as a label', () => {
    // The failure mode of a lazier check: `size={13}` is not text.
    expect(findUnnamedControls('x.tsx', '<button>\n  <Star size={13} className="a" />\n</button>')).toHaveLength(1)
  })

  // The check itself, over the whole component tree. This is the assertion
  // that matters: it is what stops the next icon button from shipping mute.
  it('finds none in the components', () => {
    const offenders = walk('src/components').flatMap((file) =>
      findUnnamedControls(file, readFileSync(file, 'utf8')),
    )
    const shown = offenders.map((one) => `${one.file}:${one.line}  ${one.snippet}`).join('\n')
    expect(shown).toBe('')
  })
})
