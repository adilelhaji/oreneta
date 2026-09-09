import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { contrastRatio, isValidColor, luminance } from './color'
import {
  BUILTIN_THEMES,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  THEME_TOKEN_KEYS,
  TOKEN_CSS_VAR,
  cssVarStyle,
  builtinTheme,
  defaultCustomInput,
  deriveThemeTokens,
  isCustomThemeId,
  newCustomThemeId,
  sanitizeCustomThemes,
  type CustomThemeInput,
} from './themes'

const SAMPLE_INPUT: CustomThemeInput = {
  appearance: 'light',
  bgApp: '#f1f5f9',
  surface: '#ffffff',
  sideNav: '#0f172a',
  accent: '#4f46e5',
  text: '#0f172a',
}

describe('BUILTIN_THEMES', () => {
  it('includes both default ids with matching appearance', () => {
    const light = BUILTIN_THEMES.find((t) => t.id === DEFAULT_LIGHT_ID)
    const dark = BUILTIN_THEMES.find((t) => t.id === DEFAULT_DARK_ID)
    expect(light?.appearance).toBe('light')
    expect(dark?.appearance).toBe('dark')
  })

  it('every builtin fills every token slot with a non-empty string', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const key of THEME_TOKEN_KEYS) {
        expect(typeof theme.tokens[key]).toBe('string')
        expect(theme.tokens[key].length).toBeGreaterThan(0)
      }
    }
  })

  it('has unique, non-custom ids and both appearances available', () => {
    const ids = BUILTIN_THEMES.map((t) => t.id)
    expect(BUILTIN_THEMES).toHaveLength(16)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isCustomThemeId(id)).toBe(false)
    expect(BUILTIN_THEMES.filter((t) => t.appearance === 'light')).toHaveLength(8)
    expect(BUILTIN_THEMES.filter((t) => t.appearance === 'dark')).toHaveLength(8)
  })
})

describe('cobalt defaults', () => {
  it('retains existing palette IDs and colors alongside distinct new defaults', () => {
    expect(DEFAULT_LIGHT_ID).toBe('oreneta-light')
    expect(DEFAULT_DARK_ID).toBe('oreneta-dark')
    expect(builtinTheme('indigo')?.tokens.accent).toBe('#4f46e5')
    expect(builtinTheme('indigo-dark')?.tokens.accent).toBe('#6366f1')
    expect(builtinTheme('light')?.tokens.accent).toBe('#0e7a58')
    expect(builtinTheme('dark')?.tokens.accent).toBe('#36b489')
    expect(builtinTheme('oreneta-light')?.tokens.accent).toBe('#2056dd')
    expect(builtinTheme('oreneta-dark')?.tokens.accent).toBe('#7ea6ff')
  })

  it('keeps the CSS default paint synchronized with every registry token', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    const fallback = css.slice(css.indexOf('/* Default Oreneta cobalt'))
    for (const [id, selector] of [
      [DEFAULT_LIGHT_ID, ':root'],
      [DEFAULT_DARK_ID, '.dark'],
    ]) {
      const start = fallback.indexOf(`${selector} {`)
      const block = fallback.slice(start, fallback.indexOf('\n}', start))
      for (const key of THEME_TOKEN_KEYS)
        expect(block).toContain(`${TOKEN_CSS_VAR[key]}: ${builtinTheme(id)!.tokens[key]};`)
    }
  })

  it('has readable body, accent buttons and semantic notices in both defaults', () => {
    for (const id of [DEFAULT_LIGHT_ID, DEFAULT_DARK_ID]) {
      const t = builtinTheme(id)!.tokens
      for (const fg of [t.textPrimary, t.textSecondary]) {
        for (const bg of [t.bgApp, t.bgChat, t.bgChats, t.bgRaised, t.bgActive])
          expect(contrastRatio(fg, bg)!).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrastRatio(t.accentText, t.accent)!).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t.accentText, t.accentHover)!).toBeGreaterThanOrEqual(4.5)
      for (const [fg, bg] of [
        [t.success, t.successSoft],
        [t.warning, t.warningSoft],
        [t.danger, t.dangerSoft],
        [t.info, t.infoSoft],
      ])
        expect(contrastRatio(fg, bg)!).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('seeds custom themes from cobalt and chooses readable filled-control text', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const input = defaultCustomInput(appearance)
      const t = deriveThemeTokens(input)
      expect(t.accent).toBe(builtinTheme(appearance === 'light' ? DEFAULT_LIGHT_ID : DEFAULT_DARK_ID)!.tokens.accent)
      expect(contrastRatio(t.accentText, t.accent)!).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('fills new slots without re-deriving or overwriting saved legacy custom colors', () => {
    const tokens = { ...deriveThemeTokens(SAMPLE_INPUT), bgApp: '#123456', accent: '#654321' } as Record<string, string>
    for (const key of [
      'success',
      'successSoft',
      'warning',
      'warningSoft',
      'danger',
      'dangerSoft',
      'info',
      'infoSoft',
      'accentText',
    ])
      delete tokens[key]
    const saved = { id: 'custom-legacy', name: 'Old choice', appearance: 'light', source: SAMPLE_INPUT, tokens }
    const restored = sanitizeCustomThemes([saved])![0]
    for (const [key, value] of Object.entries(tokens))
      expect(restored.tokens[key as keyof typeof restored.tokens]).toBe(value)
    expect(restored.tokens.warning).toBeTruthy()
    expect(restored.tokens.accentText).toBe('#ffffff')
    expect(sanitizeCustomThemes([restored])![0]).toEqual(restored)
  })

  it('restores light legacy custom accents with readable text without changing saved colors', () => {
    const tokens = { ...deriveThemeTokens(SAMPLE_INPUT), accent: '#eeeeee' } as Record<string, string>
    delete tokens.accentText
    const restored = sanitizeCustomThemes([{ id: 'custom-pale', name: 'Pale', source: SAMPLE_INPUT, tokens }])![0]
    expect(restored.tokens.accent).toBe('#eeeeee')
    expect(restored.tokens.accentText).toBe('#000000')
    expect(contrastRatio(restored.tokens.accent, restored.tokens.accentText)!).toBeGreaterThanOrEqual(4.5)
    const explicit = { ...restored, tokens: { ...restored.tokens, accentText: '#112233' } }
    expect(sanitizeCustomThemes([explicit])![0].tokens.accentText).toBe('#112233')
  })
})

describe('deriveThemeTokens', () => {
  it('produces valid colors for every color slot', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const tokens = deriveThemeTokens({ ...SAMPLE_INPUT, appearance })
      for (const key of THEME_TOKEN_KEYS) {
        if (key === 'bubbleShadowIn' || key === 'bubbleShadowOut') continue
        expect(isValidColor(tokens[key])).toBe(true)
      }
    }
  })

  it('keeps text readable: secondary text contrasts with the app background', () => {
    const light = deriveThemeTokens(SAMPLE_INPUT)
    expect(luminance(light.textSecondary)).toBeLessThan(luminance(light.bgApp))
    const dark = deriveThemeTokens({
      appearance: 'dark',
      bgApp: '#090d16',
      surface: '#0f172a',
      sideNav: '#05070c',
      accent: '#6366f1',
      text: '#f8fafc',
    })
    expect(luminance(dark.textSecondary)).toBeGreaterThan(luminance(dark.bgApp))
  })

  it('passes the editor inputs through unchanged', () => {
    const tokens = deriveThemeTokens(SAMPLE_INPUT)
    expect(tokens.bgApp).toBe(SAMPLE_INPUT.bgApp)
    expect(tokens.bgChats).toBe(SAMPLE_INPUT.surface)
    expect(tokens.bgSideNav).toBe(SAMPLE_INPUT.sideNav)
    expect(tokens.accent).toBe(SAMPLE_INPUT.accent)
    expect(tokens.textPrimary).toBe(SAMPLE_INPUT.text)
  })
})

describe('cssVarStyle', () => {
  it('maps every slot to its --me-* var', () => {
    const style = cssVarStyle(BUILTIN_THEMES[0].tokens) as Record<string, string>
    for (const key of THEME_TOKEN_KEYS) {
      expect(style[TOKEN_CSS_VAR[key]]).toBe(BUILTIN_THEMES[0].tokens[key])
    }
  })
})

describe('sanitizeCustomThemes', () => {
  const valid = {
    id: newCustomThemeId(),
    name: 'My theme',
    appearance: 'light',
    source: SAMPLE_INPUT,
    tokens: deriveThemeTokens(SAMPLE_INPUT),
  }

  it('round-trips a valid theme', () => {
    const out = sanitizeCustomThemes([valid])
    expect(out).toHaveLength(1)
    expect(out![0]).toEqual(valid as never)
  })

  it('re-derives tokens when they are missing or corrupt', () => {
    const out = sanitizeCustomThemes([{ ...valid, tokens: { bgApp: 42 } }])
    expect(out).toHaveLength(1)
    expect(out![0].tokens).toEqual(deriveThemeTokens(SAMPLE_INPUT))
  })

  it('drops entries with bad ids, duplicate ids, or invalid sources', () => {
    const out = sanitizeCustomThemes([
      { ...valid, id: 'light' }, // not custom-prefixed
      valid,
      valid, // duplicate id
      { ...valid, id: newCustomThemeId(), source: { ...SAMPLE_INPUT, accent: 'tomato' } },
    ])
    expect(out).toHaveLength(1)
  })

  it('returns null for non-array input', () => {
    expect(sanitizeCustomThemes(undefined)).toBeNull()
    expect(sanitizeCustomThemes({})).toBeNull()
  })

  it('defaults a blank name', () => {
    const out = sanitizeCustomThemes([{ ...valid, name: '  ' }])
    expect(out![0].name).toBe('Custom theme')
  })
})
