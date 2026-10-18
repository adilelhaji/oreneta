import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { composite, contrastRatio, isValidColor, luminance } from './color'
import {
  BUILTIN_THEMES,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  THEME_TOKEN_KEYS,
  TOKEN_CSS_VAR,
  UI_CONTRAST,
  cssVarStyle,
  builtinTheme,
  contrastShortfalls,
  defaultCustomInput,
  deriveThemeTokens,
  isCustomThemeId,
  newCustomThemeId,
  sanitizeCustomThemes,
  themeSurfaces,
  type CustomThemeInput,
  type ThemeTokens,
} from './themes'

const SAMPLE_INPUT: CustomThemeInput = {
  appearance: 'light',
  bgApp: '#f1f5f9',
  surface: '#ffffff',
  sideNav: '#0f172a',
  accent: '#4f46e5',
  text: '#0f172a',
}

const worst = (fg: string, backgrounds: string[]) => Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg) ?? 0))

/**
 * Accent drawn as text (the selected folder, links) and as the focus ring is
 * below its floor in these palettes. The fix changes the accent colour of a
 * palette people already chose, so it waits for the owner's decision (#287);
 * the test below fails as soon as a listed theme passes or an unlisted one fails.
 */
const ACCENT_BELOW_AA: Record<string, { text: boolean; ring: boolean }> = {
  'indigo-dark': { text: true, ring: false },
  light: { text: true, ring: false },
  mist: { text: true, ring: true },
  paper: { text: true, ring: false },
  dawn: { text: true, ring: true },
  honey: { text: true, ring: true },
  lilac: { text: true, ring: false },
  graphite: { text: true, ring: false },
}

/** WCAG AA for everything a palette paints, accent excepted (asserted apart). */
function expectReadable(t: ThemeTokens) {
  const surfaces = themeSurfaces(t)
  expect(surfaces.length).toBeGreaterThan(0)
  expect(worst(t.textPrimary, surfaces)).toBeGreaterThanOrEqual(4.5)
  expect(worst(t.textSecondary, surfaces)).toBeGreaterThanOrEqual(4.5)
  expect(worst(t.borderInput, surfaces)).toBeGreaterThanOrEqual(UI_CONTRAST)
  expect(contrastRatio(t.accentText, t.accent)!).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(t.accentText, composite(t.accentHover, t.bgChats)!)!).toBeGreaterThanOrEqual(4.5)
  for (const [fg, soft] of [
    [t.success, t.successSoft],
    [t.warning, t.warningSoft],
    [t.danger, t.dangerSoft],
    [t.info, t.infoSoft],
  ])
    expect(worst(fg, [soft, t.bgApp, t.bgChats, t.bgChat])).toBeGreaterThanOrEqual(4.5)
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

describe('frame and content tones (#287)', () => {
  it('meets WCAG AA in every built-in theme on every surface it paints', () => {
    for (const theme of BUILTIN_THEMES) expectReadable(theme.tokens)
  })

  it('keeps accent text and the focus ring at their floors, except where the owner must decide', () => {
    for (const theme of BUILTIN_THEMES) {
      const accent = worst(theme.tokens.accent, themeSurfaces(theme.tokens))
      const below = ACCENT_BELOW_AA[theme.id] ?? { text: false, ring: false }
      expect({ id: theme.id, text: accent < 4.5, ring: accent < UI_CONTRAST }).toEqual({ id: theme.id, ...below })
    }
    for (const id of [DEFAULT_LIGHT_ID, DEFAULT_DARK_ID]) expect(ACCENT_BELOW_AA[id]).toBeUndefined()
  })

  it('paints headers in the frame tone and the lists in a different content tone', () => {
    for (const theme of BUILTIN_THEMES) {
      expect({ id: theme.id, header: theme.tokens.bgHeader }).toEqual({ id: theme.id, header: theme.tokens.bgApp })
      expect(theme.tokens.bgApp).not.toBe(theme.tokens.bgChats)
    }
  })

  it('takes the approved Oreneta Light and Dark surfaces, field outline and rail', () => {
    const light = builtinTheme(DEFAULT_LIGHT_ID)!.tokens
    const dark = builtinTheme(DEFAULT_DARK_ID)!.tokens
    expect([light.bgApp, light.bgHeader, light.bgChats, light.bgChat, light.bgRaised, light.bgActive]).toEqual([
      '#e3eaf4',
      '#e3eaf4',
      '#fbfcfe',
      '#fdfdff',
      '#ffffff',
      '#d6e3fb',
    ])
    expect([light.border, light.borderInput, light.bgSideNav]).toEqual(['#d3dbe8', '#6b7a93', '#15316e'])
    expect([dark.bgApp, dark.bgHeader, dark.bgChats, dark.bgChat, dark.bgRaised, dark.bgActive]).toEqual([
      '#0c1526',
      '#0c1526',
      '#142036',
      '#111c30',
      '#1b2a42',
      '#243a5e',
    ])
    expect([dark.border, dark.borderInput, dark.bgSideNav]).toEqual(['#30415b', '#7d91b4', '#08111f'])
  })

  it('derives the frame tone and a readable field outline for custom themes', () => {
    const palettes: CustomThemeInput[] = [defaultCustomInput('light'), defaultCustomInput('dark'), SAMPLE_INPUT]
    for (const input of palettes) {
      const t = deriveThemeTokens(input)
      expect(t.bgHeader).toBe(input.bgApp)
      expect(t.bgChats).toBe(input.surface)
      // The reader is content too: never the frame tone.
      expect(t.bgChat).not.toBe(input.bgApp)
      expectReadable(t)
      // Quieter than the text: an outline, not a second text colour.
      expect(t.borderInput).not.toBe(t.textPrimary)
    }
  })
})

describe('cobalt defaults', () => {
  it('retains existing palette IDs and accents alongside distinct new defaults', () => {
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
      // The selected folder and account are accent text on the active
      // background; the automated audit flagged the dark pair at 4.42:1.
      expect(contrastRatio(t.accent, t.bgActive)!).toBeGreaterThanOrEqual(4.5)
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
      'borderInput',
    ])
      delete tokens[key]
    const saved = { id: 'custom-legacy', name: 'Old choice', appearance: 'light', source: SAMPLE_INPUT, tokens }
    const restored = sanitizeCustomThemes([saved])![0]
    for (const [key, value] of Object.entries(tokens))
      expect(restored.tokens[key as keyof typeof restored.tokens]).toBe(value)
    expect(restored.tokens.warning).toBeTruthy()
    expect(restored.tokens.accentText).toBe('#ffffff')
    // The outline is derived for the saved surfaces, the saved #123456 frame included.
    expect(worst(restored.tokens.borderInput, themeSurfaces(restored.tokens))).toBeGreaterThanOrEqual(UI_CONTRAST)
    expect(sanitizeCustomThemes([restored])![0]).toEqual(restored)
  })

  it('keeps a saved field outline and falls back to the text where no surface resolves', () => {
    const restore = (tokens: Record<string, string>) =>
      sanitizeCustomThemes([{ id: 'custom-saved', name: 'Saved', source: SAMPLE_INPUT, tokens }])![0].tokens
    expect(restore({ ...deriveThemeTokens(SAMPLE_INPUT), borderInput: '#abcdef' }).borderInput).toBe('#abcdef')
    // Derived from the saved divider and text, not from the editor source.
    const tinted: Record<string, string> = {
      ...deriveThemeTokens(SAMPLE_INPUT),
      border: '#f0d0d0',
      textPrimary: '#3a0000',
    }
    delete tinted.borderInput
    const fromTint = restore(tinted)
    expect(fromTint.borderInput).not.toBe(deriveThemeTokens(SAMPLE_INPUT).borderInput)
    expect(fromTint.borderInput).not.toBe('#3a0000')
    expect(worst(fromTint.borderInput, themeSurfaces(fromTint))).toBeGreaterThanOrEqual(UI_CONTRAST)
    const glass: Record<string, string> = { ...deriveThemeTokens(SAMPLE_INPUT) }
    for (const key of ['bgApp', 'bgHeader', 'bgChats', 'bgChat', 'bgRaised', 'bgHover', 'bgActive'])
      glass[key] = 'rgba(255, 255, 255, 0.5)'
    delete glass.borderInput
    const fromGlass = restore(glass)
    expect(fromGlass.bgApp).toBe('rgba(255, 255, 255, 0.5)')
    expect(fromGlass.borderInput).toBe(fromGlass.textPrimary)
    // Nothing up to the text reaches 3:1: the outline is the text, and the
    // editor names the text itself as unreadable.
    const faint: Record<string, string> = {
      ...deriveThemeTokens(SAMPLE_INPUT),
      border: '#f4f4f4',
      textPrimary: '#dddddd',
    }
    delete faint.borderInput
    const fromFaint = restore(faint)
    expect(fromFaint.borderInput).toBe('#dddddd')
    expect(contrastShortfalls(fromFaint).map((s) => s.pair)).toContain('text')
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
  it('derives readable secondary text for an unedited custom theme', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const t = deriveThemeTokens(defaultCustomInput(appearance))
      // The fixed blend this replaced gave 3.43:1 on the light app background
      // and 2.94:1 on a selected row.
      for (const bg of [t.bgApp, t.bgChat, t.bgChats, t.bgActive])
        expect(contrastRatio(t.textSecondary, bg)!).toBeGreaterThanOrEqual(4.5)
      expect(contrastShortfalls(t)).toEqual([])
    }
  })

  it('keeps secondary text readable whenever the chosen text itself is', () => {
    const palettes: CustomThemeInput[] = [
      SAMPLE_INPUT,
      {
        appearance: 'light',
        bgApp: '#e8e0d0',
        surface: '#f5efe3',
        sideNav: '#333333',
        accent: '#7a3e00',
        text: '#2b2b2b',
      },
      {
        appearance: 'dark',
        bgApp: '#202020',
        surface: '#2a2a2a',
        sideNav: '#111111',
        accent: '#ffb000',
        text: '#d0d0d0',
      },
      {
        appearance: 'dark',
        bgApp: '#000000',
        surface: '#0a0a0a',
        sideNav: '#000000',
        accent: '#66ccff',
        text: '#ffffff',
      },
    ]
    for (const input of palettes) {
      const t = deriveThemeTokens(input)
      expect(contrastShortfalls(t).some((s) => s.pair === 'text')).toBe(false)
      for (const bg of [t.bgApp, t.bgChat, t.bgChats, t.bgActive])
        expect(contrastRatio(t.textSecondary, bg)!).toBeGreaterThanOrEqual(4.5)
      // Still secondary: never the primary colour unless nothing else reads.
      expect(t.textSecondary).not.toBe(t.textPrimary)
    }
  })

  it('names an accent that reads on the lists but not on the frame tone', () => {
    // The cobalt dark accent reads on the dark list but not on a lighter frame.
    const t = { ...deriveThemeTokens(defaultCustomInput('dark')), bgApp: '#3a4a6a', bgHeader: '#3a4a6a' }
    expect(contrastRatio(t.accent, t.bgChats)!).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(t.accent, t.bgApp)!).toBeLessThan(4.5)
    expect(contrastShortfalls(t).map((s) => s.pair)).toContain('accent')
  })

  it('names what the chosen colours themselves leave unreadable', () => {
    const t = deriveThemeTokens({
      appearance: 'dark',
      bgApp: '#101b2e',
      surface: '#152137',
      sideNav: '#0b162b',
      accent: '#3b5bdb',
      text: '#6b7280',
    })
    const shortfalls = contrastShortfalls(t)
    expect(shortfalls.map((s) => s.pair)).toEqual(['text', 'accent'])
    for (const s of shortfalls) expect(s.ratio).toBeLessThan(4.5)
    // With nothing readable to fade toward, secondary text is the text itself.
    expect(t.textSecondary).toBe(t.textPrimary)
  })

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
