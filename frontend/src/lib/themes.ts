import type { CSSProperties } from 'react'
import { composite, contrastRatio, darken, isValidColor, lighten, mix, withAlpha } from './color'

// Theme registry and derivation. A theme is a complete set of values for the
// `--me-*` CSS custom properties in index.css. Built-ins live here; custom
// themes are derived from a handful of editor inputs (CustomThemeInput) and
// persisted with their full token map in settings (`custom_themes`).

export type Appearance = 'light' | 'dark'

/**
 * One value per CSS custom property slot. Colors are CSS color strings;
 * the two shadow slots are full box-shadow values.
 */
type BaseThemeTokens = {
  bgApp: string
  bgChat: string
  bgChatOverlay: string
  bgSideNav: string
  bgChats: string
  bgHeader: string
  bgHover: string
  bgRaised: string
  bgActive: string
  border: string
  textPrimary: string
  textSecondary: string
  accent: string
  accentHover: string
  bubbleIn: string
  bubbleInText: string
  bubbleOut: string
  bubbleOutText: string
  composerBg: string
  composerBorder: string
  bubbleShadowIn: string
  bubbleShadowOut: string
}

type SemanticThemeTokens = {
  success: string
  successSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
  info: string
  infoSoft: string
  accentText: string
}

/**
 * Slots every theme has but a palette need not pin: when it does not, they are
 * derived from its other colours so they meet their contrast floor.
 */
type DerivedThemeTokens = {
  /** Outline of fields, selects and checkboxes (WCAG 1.4.11, 3:1). */
  borderInput: string
  /**
   * The accent drawn as text, an icon or a focus ring (not as a fill): the
   * accent moved toward the text only as far as it needs to reach 4.5:1 on
   * every surface (#311). Equal to the accent when it already does.
   */
  accentFg: string
}

export type ThemeTokens = BaseThemeTokens & SemanticThemeTokens & DerivedThemeTokens

function accentTextFor(accent: string): string {
  return (contrastRatio(accent, '#ffffff') ?? 21) >= (contrastRatio(accent, '#000000') ?? 0) ? '#ffffff' : '#000000'
}

function semanticTokens(appearance: Appearance): SemanticThemeTokens {
  return appearance === 'light'
    ? {
        success: '#166534',
        successSoft: '#e8f5ec',
        warning: '#795000',
        warningSoft: '#fff3d6',
        danger: '#a32032',
        dangerSoft: '#fce9ed',
        info: '#2056dd',
        infoSoft: '#e7eefb',
        accentText: '#ffffff',
      }
    : {
        success: '#8addac',
        successSoft: '#163629',
        warning: '#ffdc91',
        warningSoft: '#392e18',
        danger: '#ffabb8',
        dangerSoft: '#411e2a',
        info: '#a0bdff',
        infoSoft: '#203554',
        accentText: '#ffffff',
      }
}

export const TOKEN_CSS_VAR: Record<keyof ThemeTokens, string> = {
  success: '--me-success',
  successSoft: '--me-success-soft',
  warning: '--me-warning',
  warningSoft: '--me-warning-soft',
  danger: '--me-danger',
  dangerSoft: '--me-danger-soft',
  info: '--me-info',
  infoSoft: '--me-info-soft',
  accentText: '--me-accent-text',
  borderInput: '--me-border-input',
  accentFg: '--me-accent-fg',
  bgApp: '--me-bg-app',
  bgChat: '--me-bg-chat',
  bgChatOverlay: '--me-bg-chat-overlay',
  bgSideNav: '--me-bg-sidenav',
  bgChats: '--me-bg-chats',
  bgHeader: '--me-bg-header',
  bgHover: '--me-bg-hover',
  bgRaised: '--me-bg-raised',
  bgActive: '--me-bg-active',
  border: '--me-border',
  textPrimary: '--me-text-primary',
  textSecondary: '--me-text-secondary',
  accent: '--me-accent',
  accentHover: '--me-accent-hover',
  bubbleIn: '--me-bubble-in',
  bubbleInText: '--me-bubble-in-text',
  bubbleOut: '--me-bubble-out',
  bubbleOutText: '--me-bubble-out-text',
  composerBg: '--me-composer-bg',
  composerBorder: '--me-composer-border',
  bubbleShadowIn: '--me-bubble-shadow-in',
  bubbleShadowOut: '--me-bubble-shadow-out',
}

export const THEME_TOKEN_KEYS = Object.keys(TOKEN_CSS_VAR) as (keyof ThemeTokens)[]

export type ThemeDef = {
  /** Built-ins: "light", "dark", "mist", ... Custom themes: "custom-<random>". */
  id: string
  name: string
  appearance: Appearance
  tokens: ThemeTokens
}

/** The 6 inputs the custom theme editor exposes; everything else is derived. */
export type CustomThemeInput = {
  appearance: Appearance
  /** Window background behind everything. */
  bgApp: string
  /** Panels: thread list, header, composer, incoming bubbles. */
  surface: string
  /** The module bar: the narrow bar of module icons from 769 to 1024 px (#354). */
  sideNav: string
  accent: string
  /** Primary text color. */
  text: string
}

export type CustomTheme = ThemeDef & { source: CustomThemeInput }

/** WCAG AA for body-size text. */
export const READABLE_CONTRAST = 4.5
/** WCAG AA for the boundary of a control and the focus ring (1.4.11). */
export const UI_CONTRAST = 3

type SurfaceTokens = Pick<
  ThemeTokens,
  'bgApp' | 'bgHeader' | 'bgChats' | 'bgChat' | 'bgRaised' | 'bgHover' | 'bgActive'
>

/**
 * Every opaque colour text and controls are drawn on: the frame, the content
 * and the raised surfaces, with the translucent ones (hover and raised in some
 * dark palettes) resolved over the content and over the frame, where they are
 * painted. A surface that cannot be resolved is left out, not guessed.
 */
export function themeSurfaces(tokens: SurfaceTokens): string[] {
  const { bgApp, bgHeader, bgChats, bgChat, bgRaised, bgHover, bgActive } = tokens
  const out = new Set<string>()
  for (const under of [bgChats, bgApp]) {
    for (const value of [bgApp, bgHeader, bgChats, bgChat, bgRaised, bgHover, bgActive]) {
      const resolved = composite(value, under)
      if (resolved) out.add(resolved)
    }
  }
  return [...out]
}

/**
 * Field outline: the divider colour moved toward the text only as far as it
 * needs to reach 3:1 on every surface, so it stays quieter than the text.
 * Best effort beyond that: with no resolvable surface (contrast unknown), or
 * when nothing up to the text itself reaches 3:1, the outline is the text
 * colour, the strongest the palette offers. The editor names a text shortfall.
 */
function readableInputBorder(border: string, text: string, surfaces: string[]): string {
  if (surfaces.length === 0) return text
  for (let step = 0; step <= 50; step++) {
    const candidate = mix(border, text, step / 50)
    if (surfaces.every((bg) => (contrastRatio(candidate, bg) ?? 0) >= UI_CONTRAST)) return candidate
  }
  return text
}

/**
 * Accent as text, icon and focus ring: the accent moved toward the text only
 * as far as it needs to reach 4.5:1 (which also clears the ring's 3:1) on every
 * surface, so its hue stays and the accent fill is never touched. The accent
 * itself when it already passes or when no surface resolves (contrast unknown);
 * the text when nothing short of it passes, which the editor names as an
 * accent shortfall.
 */
function readableAccent(accent: string, text: string, surfaces: string[]): string {
  if (surfaces.length === 0) return accent
  for (let step = 0; step <= 100; step++) {
    const candidate = step === 0 ? accent : mix(accent, text, step / 100)
    if (surfaces.every((bg) => (contrastRatio(candidate, bg) ?? 0) >= READABLE_CONTRAST)) return candidate
  }
  return text
}

function derivedTokens(tokens: BaseThemeTokens): DerivedThemeTokens {
  const surfaces = themeSurfaces(tokens)
  return {
    borderInput: readableInputBorder(tokens.border, tokens.textPrimary, surfaces),
    accentFg: readableAccent(tokens.accent, tokens.textPrimary, surfaces),
  }
}

/**
 * Secondary text: the primary text faded toward the background, but only as
 * far as it stays readable on every opaque surface it is drawn on. A fixed
 * blend left an unedited custom theme at 2.9:1 on a selected row.
 */
function readableSecondary(text: string, toward: string, backgrounds: string[]): string {
  for (let weight = 0.45; weight > 0; weight -= 0.01) {
    const candidate = mix(text, toward, weight)
    if (backgrounds.every((bg) => (contrastRatio(candidate, bg) ?? 0) >= READABLE_CONTRAST)) return candidate
  }
  return text
}

/**
 * Where a custom palette cannot be made readable by derivation alone, because
 * the chosen colors themselves are too close. The editor names these so the
 * person choosing can see it; it does not stop them saving.
 */
export type ContrastShortfall = { pair: 'text' | 'accent'; ratio: number }

export function contrastShortfalls(tokens: ThemeTokens): ContrastShortfall[] {
  const worst = (fg: string, backgrounds: string[]) => Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg) ?? 0))
  const text = worst(tokens.textPrimary, themeSurfaces(tokens))
  // The accent as text and ring (#311) is drawn on the selected folder, account
  // and sort header, and the folder pane and headers sit on the frame tone (#287).
  // It is derived, so it falls short only when the palette leaves no room.
  const accent = worst(tokens.accentFg, [tokens.bgApp, tokens.bgHeader, tokens.bgChats, tokens.bgActive])
  const shortfalls: ContrastShortfall[] = []
  if (text < READABLE_CONTRAST) shortfalls.push({ pair: 'text', ratio: text })
  if (accent < READABLE_CONTRAST) shortfalls.push({ pair: 'accent', ratio: accent })
  return shortfalls
}

/**
 * Expand the 6 editor inputs into a full token map: the frame (window, headers)
 * from `bgApp`, the content (lists, reader) from `surface`. The formulas give a
 * coherent palette from any inputs; they approximate, not reproduce, the
 * hand-picked Oreneta Light/Dark values (those also pin hover, raised and
 * selection by hand).
 */
export function deriveThemeTokens(input: CustomThemeInput): ThemeTokens {
  const { appearance, bgApp, surface, sideNav, accent, text } = input
  const light = appearance === 'light'

  // The reader is content, so in dark it sits between the frame and the list
  // rather than taking the frame tone itself (#287).
  const bgChat = light ? lighten(bgApp, 0.5) : mix(bgApp, surface, 0.5)
  const border = mix(surface, text, 0.12)
  const bgActive = light ? mix(surface, text, 0.12) : lighten(surface, 0.1)
  const bgHover = light ? mix(surface, text, 0.06) : withAlpha(lighten(surface, 0.08), 0.6)
  const bgRaised = light ? mix(surface, bgApp, 0.5) : withAlpha(surface, 0.4)
  // Frame tone (#287): headers and bars share the window background; the
  // lists and the reader keep the content surface.
  const bgHeader = bgApp
  const surfaces = themeSurfaces({ bgApp, bgHeader, bgChats: surface, bgChat, bgRaised, bgHover, bgActive })
  const base: BaseThemeTokens = {
    bgApp,
    bgChat,
    bgChatOverlay: withAlpha(bgChat, light ? 0.94 : 0.95),
    bgSideNav: sideNav,
    bgChats: surface,
    bgHeader,
    bgHover,
    bgRaised,
    bgActive,
    border,
    textPrimary: text,
    textSecondary: readableSecondary(text, bgApp, surfaces),
    accent,
    accentHover: light ? darken(accent, 0.1) : lighten(accent, 0.12),
    bubbleIn: light ? surface : lighten(surface, 0.08),
    bubbleInText: text,
    bubbleOut: light ? mix(accent, '#ffffff', 0.8) : mix(accent, surface, 0.55),
    bubbleOutText: light ? darken(accent, 0.45) : mix(accent, '#ffffff', 0.75),
    composerBg: surface,
    composerBorder: border,
    bubbleShadowIn: light
      ? `0 2px 8px -2px ${withAlpha(text, 0.08)}, 0 1px 3px -1px ${withAlpha(text, 0.04)}`
      : '0 4px 12px -3px rgba(0, 0, 0, 0.3), 0 1px 4px -2px rgba(0, 0, 0, 0.2)',
    bubbleShadowOut: light
      ? `0 2px 8px -2px ${withAlpha(accent, 0.12)}, 0 1px 3px -1px ${withAlpha(accent, 0.06)}`
      : '0 4px 12px -3px rgba(0, 0, 0, 0.4), 0 1px 4px -2px rgba(0, 0, 0, 0.3)',
  }
  return {
    ...base,
    ...semanticTokens(appearance),
    accentText: accentTextFor(accent),
    borderInput: readableInputBorder(border, text, surfaces),
    accentFg: readableAccent(accent, text, surfaces),
  }
}

// Legacy green palettes retain their persisted IDs and accents. #287 moved their
// headers to the frame tone and darkened secondary text that read under 4.5:1.
const MERON_LIGHT: BaseThemeTokens = {
  bgApp: '#f0f2f1',
  bgChat: '#f8faf9',
  bgChatOverlay: 'rgba(248, 250, 249, 0.94)',
  bgSideNav: '#121a16',
  bgChats: '#ffffff',
  bgHeader: '#f0f2f1',
  bgHover: '#eef1f0',
  bgRaised: '#f7f9f8',
  bgActive: '#e2e7e4',
  border: '#e0e6e2',
  textPrimary: '#1b211e',
  textSecondary: '#5e6964', // was #68746e, under 4.5:1 on its own surfaces (#287)
  accent: '#0e7a58',
  accentHover: '#0b6448',
  bubbleIn: '#ffffff',
  bubbleInText: '#1b211e',
  bubbleOut: '#ddeee6',
  bubbleOutText: '#14543e',
  composerBg: '#ffffff',
  composerBorder: '#e0e6e2',
  bubbleShadowIn: '0 2px 8px -2px rgba(27, 33, 30, 0.08), 0 1px 3px -1px rgba(27, 33, 30, 0.04)',
  bubbleShadowOut: '0 2px 8px -2px rgba(14, 122, 88, 0.12), 0 1px 3px -1px rgba(14, 122, 88, 0.06)',
}

const MERON_DARK: BaseThemeTokens = {
  bgApp: '#0c100e',
  bgChat: '#0c100e',
  bgChatOverlay: 'rgba(12, 16, 14, 0.95)',
  bgSideNav: '#070a09',
  bgChats: '#151b18',
  bgHeader: '#0c100e',
  bgHover: 'rgba(38, 47, 42, 0.6)',
  bgRaised: 'rgba(21, 27, 24, 0.4)',
  bgActive: '#222b26',
  border: '#28332d',
  textPrimary: '#f2f5f3',
  textSecondary: '#98a39d',
  accent: '#36b489',
  accentHover: '#4cc49a',
  bubbleIn: '#1f2823',
  bubbleInText: '#f2f5f3',
  bubbleOut: '#1c463a',
  bubbleOutText: '#d6eee2',
  composerBg: '#151b18',
  composerBorder: '#28332d',
  bubbleShadowIn: '0 4px 12px -3px rgba(0, 0, 0, 0.3), 0 1px 4px -2px rgba(0, 0, 0, 0.2)',
  bubbleShadowOut: '0 4px 12px -3px rgba(0, 0, 0, 0.4), 0 1px 4px -2px rgba(0, 0, 0, 0.3)',
}

// Retained Indigo palettes. New-profile defaults are the cobalt palettes below.
const INDIGO_LIGHT: BaseThemeTokens = {
  bgApp: '#f1f5f9',
  bgChat: '#f8fafc',
  bgChatOverlay: 'rgba(248, 250, 252, 0.94)',
  bgSideNav: '#0f172a',
  bgChats: '#ffffff',
  bgHeader: '#f1f5f9',
  bgHover: '#f1f5f9',
  bgRaised: '#f8fafc',
  bgActive: '#e2e8f0',
  border: '#e2e8f0',
  textPrimary: '#0f172a',
  textSecondary: '#5a697f', // was #64748b, under 4.5:1 on its own surfaces (#287)
  accent: '#4f46e5',
  accentHover: '#4338ca',
  bubbleIn: '#ffffff',
  bubbleInText: '#0f172a',
  bubbleOut: '#e0e7ff',
  bubbleOutText: '#312e81',
  composerBg: '#ffffff',
  composerBorder: '#e2e8f0',
  bubbleShadowIn: '0 2px 8px -2px rgba(15, 23, 42, 0.08), 0 1px 3px -1px rgba(15, 23, 42, 0.04)',
  bubbleShadowOut: '0 2px 8px -2px rgba(79, 70, 229, 0.12), 0 1px 3px -1px rgba(79, 70, 229, 0.06)',
}

const INDIGO_DARK: BaseThemeTokens = {
  bgApp: '#090d16',
  bgChat: '#090d16',
  bgChatOverlay: 'rgba(9, 13, 22, 0.95)',
  bgSideNav: '#05070c',
  bgChats: '#0f172a',
  bgHeader: '#090d16',
  bgHover: 'rgba(30, 41, 59, 0.6)',
  bgRaised: 'rgba(15, 23, 42, 0.4)',
  bgActive: '#1e293b',
  border: '#1e293b',
  textPrimary: '#f8fafc',
  textSecondary: '#94a3b8',
  accent: '#6366f1',
  accentHover: '#818cf8',
  bubbleIn: '#1e293b',
  bubbleInText: '#f8fafc',
  bubbleOut: '#312e81',
  bubbleOutText: '#e0e7ff',
  composerBg: '#0f172a',
  composerBorder: '#1e293b',
  bubbleShadowIn: '0 4px 12px -3px rgba(0, 0, 0, 0.3), 0 1px 4px -2px rgba(0, 0, 0, 0.2)',
  bubbleShadowOut: '0 4px 12px -3px rgba(0, 0, 0, 0.4), 0 1px 4px -2px rgba(0, 0, 0, 0.3)',
}

// The remaining built-ins start from the editor derivation, then pin the roles
// that need hand-tuning to feel coherent across the full app surface.
const MIST: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'light',
    bgApp: '#edf4f7',
    surface: '#ffffff',
    sideNav: '#123947',
    accent: '#0ea5b7',
    text: '#14323c',
  }),
  bgChat: '#f5fafb',
  bgChatOverlay: 'rgba(245, 250, 251, 0.94)',
  bgHover: '#e7f2f5',
  bgRaised: '#f4fafb',
  bgActive: '#d7eaef',
  border: '#cfe0e5',
  textSecondary: '#516b74', // was #6f8790, under 4.5:1 on its own surfaces (#287)
  bubbleIn: '#ffffff',
  bubbleOut: '#d5f0f4',
  bubbleOutText: '#0e5663',
  composerBg: '#ffffff',
  composerBorder: '#cfe0e5',
  bubbleShadowIn: '0 2px 8px -2px rgba(20, 50, 60, 0.1), 0 1px 3px -1px rgba(20, 50, 60, 0.06)',
  bubbleShadowOut: '0 2px 8px -2px rgba(14, 165, 183, 0.18), 0 1px 3px -1px rgba(14, 165, 183, 0.1)',
}

const PAPER: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'light',
    bgApp: '#f4f1ea',
    surface: '#fffdf8',
    sideNav: '#263238',
    accent: '#64748b',
    text: '#2f3a3d',
  }),
  bgChat: '#fbf8f1',
  bgChatOverlay: 'rgba(251, 248, 241, 0.94)',
  bgHover: '#eee8dd',
  bgRaised: '#faf6ee',
  bgActive: '#e6ded1',
  border: '#ded4c4',
  textSecondary: '#5c6463', // was #7b817d, under 4.5:1 on its own surfaces (#287)
  bubbleIn: '#fffdf8',
  bubbleOut: '#e5edf2',
  bubbleOutText: '#334155',
  composerBg: '#fffdf8',
  composerBorder: '#ded4c4',
  bubbleShadowIn: '0 2px 8px -2px rgba(47, 58, 61, 0.1), 0 1px 3px -1px rgba(47, 58, 61, 0.06)',
  bubbleShadowOut: '0 2px 8px -2px rgba(100, 116, 139, 0.16), 0 1px 3px -1px rgba(100, 116, 139, 0.1)',
}

const DAWN: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'light',
    bgApp: '#f7ede8',
    surface: '#fffaf7',
    sideNav: '#35263b',
    accent: '#c06c84',
    text: '#4a3f4d',
  }),
  bgChat: '#fbf1ed',
  bgChatOverlay: 'rgba(251, 241, 237, 0.94)',
  bgHover: '#f1e3dd',
  bgRaised: '#fff6f2',
  bgActive: '#ead8d1',
  border: '#e1cfc7',
  textSecondary: '#695d67', // was #897c83, under 4.5:1 on its own surfaces (#287)
  bubbleIn: '#fffaf7',
  bubbleOut: '#f5dada',
  bubbleOutText: '#753849',
  composerBg: '#fffaf7',
  composerBorder: '#e1cfc7',
  bubbleShadowIn: '0 2px 8px -2px rgba(74, 63, 77, 0.1), 0 1px 3px -1px rgba(74, 63, 77, 0.06)',
  bubbleShadowOut: '0 2px 8px -2px rgba(192, 108, 132, 0.18), 0 1px 3px -1px rgba(192, 108, 132, 0.1)',
}

const GRAPHITE: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'dark',
    bgApp: '#181a1f',
    surface: '#23262d',
    sideNav: '#111318',
    accent: '#8b9bb4',
    text: '#eef0f3',
  }),
  bgChat: '#1b1d22',
  bgChatOverlay: 'rgba(27, 29, 34, 0.95)',
  bgHover: 'rgba(52, 56, 66, 0.72)',
  bgRaised: '#202329',
  bgActive: '#343842',
  border: '#393e49',
  textSecondary: '#a8b0bc',
  bubbleIn: '#2b2f38',
  bubbleOut: '#3a4350',
  bubbleOutText: '#eef3f8',
  composerBg: '#23262d',
  composerBorder: '#393e49',
}

const MIDNIGHT: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'dark',
    bgApp: '#0b1120',
    surface: '#111827',
    sideNav: '#050814',
    accent: '#38bdf8',
    text: '#f8fafc',
  }),
  bgChat: '#0d1526',
  bgChatOverlay: 'rgba(13, 21, 38, 0.95)',
  bgHover: 'rgba(30, 41, 59, 0.74)',
  bgRaised: '#101827',
  bgActive: '#1e293b',
  border: '#26354d',
  textSecondary: '#94a3b8',
  bubbleIn: '#1e293b',
  bubbleOut: '#12324a',
  bubbleOutText: '#dff6ff',
  composerBg: '#111827',
  composerBorder: '#26354d',
}

const FOREST: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'dark',
    bgApp: '#101813',
    surface: '#17231c',
    sideNav: '#0b120e',
    accent: '#7ccf9b',
    text: '#f0f6ef',
  }),
  bgChat: '#111a15',
  bgChatOverlay: 'rgba(17, 26, 21, 0.95)',
  bgHover: 'rgba(42, 62, 50, 0.72)',
  bgRaised: '#152018',
  bgActive: '#263a2e',
  border: '#2f4638',
  textSecondary: '#a6b8aa',
  bubbleIn: '#203126',
  bubbleOut: '#264936',
  bubbleOutText: '#e2f8e9',
  composerBg: '#17231c',
  composerBorder: '#2f4638',
}

const HONEY: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'light',
    bgApp: '#f7f1e6',
    surface: '#fffdf7',
    sideNav: '#33270f',
    accent: '#b07c10',
    text: '#3a3122',
  }),
  bgChat: '#fbf6ec',
  bgChatOverlay: 'rgba(251, 246, 236, 0.94)',
  bgHover: '#f1e9d8',
  bgRaised: '#faf4e8',
  bgActive: '#eadfc6',
  border: '#e7dcc2',
  textSecondary: '#6c624d', // was #8b8068, under 4.5:1 on its own surfaces (#287)
  bubbleIn: '#fffdf7',
  bubbleOut: '#f5e6c4',
  bubbleOutText: '#6e4d09',
  composerBg: '#fffdf7',
  composerBorder: '#e7dcc2',
  bubbleShadowIn: '0 2px 8px -2px rgba(58, 49, 34, 0.1), 0 1px 3px -1px rgba(58, 49, 34, 0.06)',
  bubbleShadowOut: '0 2px 8px -2px rgba(176, 124, 16, 0.16), 0 1px 3px -1px rgba(176, 124, 16, 0.1)',
}

const LILAC: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'light',
    bgApp: '#f2f0f8',
    surface: '#fdfcff',
    sideNav: '#2b2440',
    accent: '#7a5bc4',
    text: '#34304a',
  }),
  bgChat: '#f7f5fb',
  bgChatOverlay: 'rgba(247, 245, 251, 0.94)',
  bgHover: '#ebe8f4',
  bgRaised: '#f6f4fb',
  bgActive: '#dfd9ee',
  border: '#ded8ea',
  textSecondary: '#635d79', // was #7e7894, under 4.5:1 on its own surfaces (#287)
  bubbleIn: '#fdfcff',
  bubbleOut: '#e8def8',
  bubbleOutText: '#4b3389',
  composerBg: '#fdfcff',
  composerBorder: '#ded8ea',
  bubbleShadowIn: '0 2px 8px -2px rgba(52, 48, 74, 0.1), 0 1px 3px -1px rgba(52, 48, 74, 0.06)',
  bubbleShadowOut: '0 2px 8px -2px rgba(122, 91, 196, 0.16), 0 1px 3px -1px rgba(122, 91, 196, 0.1)',
}

const PLUM: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'dark',
    bgApp: '#151019',
    surface: '#1f1826',
    sideNav: '#0d0a11',
    accent: '#b48ae0',
    text: '#f2eef6',
  }),
  bgChat: '#171219',
  bgChatOverlay: 'rgba(23, 18, 25, 0.95)',
  bgHover: 'rgba(57, 46, 70, 0.7)',
  bgRaised: '#1c1522',
  bgActive: '#332945',
  border: '#3a2f4b',
  textSecondary: '#a89db8',
  bubbleIn: '#2a2135',
  bubbleOut: '#3e2f58',
  bubbleOutText: '#ecdffb',
  composerBg: '#1f1826',
  composerBorder: '#3a2f4b',
}

const EMBER: BaseThemeTokens = {
  ...deriveThemeTokens({
    appearance: 'dark',
    bgApp: '#181210',
    surface: '#231a15',
    sideNav: '#0f0b09',
    accent: '#e1854c',
    text: '#f6efe9',
  }),
  bgChat: '#1a1411',
  bgChatOverlay: 'rgba(26, 20, 17, 0.95)',
  bgHover: 'rgba(64, 48, 38, 0.7)',
  bgRaised: '#201813',
  bgActive: '#3b2c21',
  border: '#423227',
  textSecondary: '#b4a294',
  bubbleIn: '#2e221b',
  bubbleOut: '#4f3320',
  bubbleOutText: '#fae3cf',
  composerBg: '#231a15',
  composerBorder: '#423227',
}

// Frame and content tones (#287): the frame (window, headers, bars) is the
// deeper tone, lists and the reader the lighter one, fields white.
const ORENETA_LIGHT: BaseThemeTokens = {
  ...INDIGO_LIGHT,
  bgApp: '#e3eaf4',
  bgChat: '#fdfdff',
  bgChatOverlay: 'rgba(253, 253, 255, 0.94)',
  bgSideNav: '#15316e',
  bgChats: '#fbfcfe',
  bgHeader: '#e3eaf4',
  bgHover: '#ebf0f8',
  bgRaised: '#ffffff',
  bgActive: '#d6e3fb',
  border: '#d3dbe8',
  textPrimary: '#182840',
  textSecondary: '#52637d',
  accent: '#2056dd',
  accentHover: '#1946b9',
  bubbleIn: '#fbfcfe',
  bubbleInText: '#182840',
  bubbleOut: '#e7eefb',
  bubbleOutText: '#182840',
  composerBg: '#ffffff',
  composerBorder: '#d3dbe8',
  bubbleShadowOut: INDIGO_LIGHT.bubbleShadowIn,
}
const ORENETA_DARK: BaseThemeTokens = {
  ...INDIGO_DARK,
  bgApp: '#0c1526',
  bgChat: '#111c30',
  bgChatOverlay: 'rgba(17, 28, 48, 0.95)',
  bgSideNav: '#08111f',
  bgChats: '#142036',
  bgHeader: '#0c1526',
  bgHover: '#22314c',
  bgRaised: '#1b2a42',
  bgActive: '#243a5e',
  border: '#30415b',
  textPrimary: '#e6edf9',
  textSecondary: '#a7b8d2',
  accent: '#7ea6ff',
  accentHover: '#a0bdff',
  bubbleIn: '#1b2a42',
  bubbleInText: '#e6edf9',
  bubbleOut: '#293f63',
  bubbleOutText: '#e6edf9',
  composerBg: '#1b2a42',
  composerBorder: '#30415b',
}

/**
 * `pinned` holds hand-tuned values for slots that are otherwise derived. It is
 * kept apart from `tokens` because the derived palettes above spread a full
 * derivation, whose slots were computed for the editor inputs rather than for
 * the colours pinned over them.
 */
const BUILTIN_PALETTES: Array<
  Omit<ThemeDef, 'tokens'> & { tokens: BaseThemeTokens; pinned?: Partial<DerivedThemeTokens> }
> = [
  {
    id: 'oreneta-light',
    name: 'Oreneta Light',
    appearance: 'light',
    tokens: ORENETA_LIGHT,
    pinned: { borderInput: '#6b7a93' },
  },
  {
    id: 'oreneta-dark',
    name: 'Oreneta Dark',
    appearance: 'dark',
    tokens: ORENETA_DARK,
    pinned: { borderInput: '#7d91b4' },
  },
  { id: 'indigo', name: 'Indigo', appearance: 'light', tokens: INDIGO_LIGHT },
  { id: 'indigo-dark', name: 'Indigo Dark', appearance: 'dark', tokens: INDIGO_DARK },
  { id: 'light', name: 'Legacy Green', appearance: 'light', tokens: MERON_LIGHT },
  { id: 'dark', name: 'Legacy Green Dark', appearance: 'dark', tokens: MERON_DARK },
  { id: 'mist', name: 'Mist', appearance: 'light', tokens: MIST },
  { id: 'paper', name: 'Paper', appearance: 'light', tokens: PAPER },
  { id: 'dawn', name: 'Dawn', appearance: 'light', tokens: DAWN },
  { id: 'honey', name: 'Honey', appearance: 'light', tokens: HONEY },
  { id: 'lilac', name: 'Lilac', appearance: 'light', tokens: LILAC },
  { id: 'graphite', name: 'Graphite', appearance: 'dark', tokens: GRAPHITE },
  { id: 'midnight', name: 'Midnight', appearance: 'dark', tokens: MIDNIGHT },
  { id: 'forest', name: 'Forest', appearance: 'dark', tokens: FOREST },
  { id: 'plum', name: 'Plum', appearance: 'dark', tokens: PLUM },
  { id: 'ember', name: 'Ember', appearance: 'dark', tokens: EMBER },
]

export const BUILTIN_THEMES: ThemeDef[] = BUILTIN_PALETTES.map(({ pinned, ...theme }) => ({
  ...theme,
  tokens: {
    ...theme.tokens,
    ...semanticTokens(theme.appearance),
    accentText: theme.id === 'oreneta-dark' ? '#101b2e' : accentTextFor(theme.tokens.accent),
    ...derivedTokens(theme.tokens),
    ...pinned,
  },
}))

export const DEFAULT_LIGHT_ID = 'oreneta-light'
export const DEFAULT_DARK_ID = 'oreneta-dark'

export function builtinTheme(id: string): ThemeDef | undefined {
  return BUILTIN_THEMES.find((theme) => theme.id === id)
}

export function defaultThemeId(appearance: Appearance): string {
  return appearance === 'light' ? DEFAULT_LIGHT_ID : DEFAULT_DARK_ID
}

/** Editor seed for a new custom theme: the default theme's source palette. */
export function defaultCustomInput(appearance: Appearance): CustomThemeInput {
  return appearance === 'light'
    ? { appearance, bgApp: '#e3eaf4', surface: '#fbfcfe', sideNav: '#15316e', accent: '#2056dd', text: '#182840' }
    : { appearance, bgApp: '#0c1526', surface: '#142036', sideNav: '#08111f', accent: '#7ea6ff', text: '#e6edf9' }
}

export function newCustomThemeId(): string {
  return `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function isCustomThemeId(id: string): boolean {
  return id.startsWith('custom-')
}

/**
 * Inline-style record assigning every token to its CSS var. Used to scope a
 * theme to a subtree (swatches, editor preview): inline vars on a wrapper
 * override the inherited ones, so the token utilities (`bg-app`, `bg-accent`, ...) work inside it.
 */
export function cssVarStyle(tokens: ThemeTokens): CSSProperties {
  const style: Record<string, string> = {}
  for (const key of THEME_TOKEN_KEYS) {
    style[TOKEN_CSS_VAR[key]] = tokens[key]
  }
  return style as CSSProperties
}

function sanitizeTokens(raw: unknown, appearance: Appearance): ThemeTokens | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const out = {} as Record<keyof ThemeTokens, string>
  const saved = (key: keyof ThemeTokens) => (typeof obj[key] === 'string' ? (obj[key] as string) : '')
  const surfaces = themeSurfaces({
    bgApp: saved('bgApp'),
    bgHeader: saved('bgHeader'),
    bgChats: saved('bgChats'),
    bgChat: saved('bgChat'),
    bgRaised: saved('bgRaised'),
    bgHover: saved('bgHover'),
    bgActive: saved('bgActive'),
  })
  const fallback = {
    ...semanticTokens(appearance),
    accentText: accentTextFor(saved('accent')),
    // The field outline and the accent as text are derived from the saved
    // colours themselves, so a palette saved before the slots existed keeps
    // every colour it had.
    borderInput: readableInputBorder(saved('border'), saved('textPrimary'), surfaces),
    accentFg: readableAccent(saved('accent'), saved('textPrimary'), surfaces),
  }
  for (const key of THEME_TOKEN_KEYS) {
    // Preserve every saved palette value; fill only the newly added slots.
    const value = obj[key] ?? (fallback as Partial<ThemeTokens>)[key]
    if (typeof value !== 'string' || !value) return null
    out[key] = value
  }
  return out
}

function sanitizeSource(raw: unknown): CustomThemeInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const appearance = obj.appearance
  if (appearance !== 'light' && appearance !== 'dark') return null
  const colors = {} as Record<'bgApp' | 'surface' | 'sideNav' | 'accent' | 'text', string>
  for (const key of ['bgApp', 'surface', 'sideNav', 'accent', 'text'] as const) {
    const value = obj[key]
    if (typeof value !== 'string' || !isValidColor(value)) return null
    colors[key] = value
  }
  return { appearance, ...colors }
}

/**
 * Validate the persisted `custom_themes` JSON. Entries with a valid source but
 * missing/corrupt tokens are re-derived; entries without a valid source are
 * dropped. Follows the sanitizeKanbanBoards convention: null = unusable input.
 */
export function sanitizeCustomThemes(raw: unknown): CustomTheme[] | null {
  if (!Array.isArray(raw)) return null
  const out: CustomTheme[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const obj = item as Record<string, unknown>
    if (typeof obj.id !== 'string' || !isCustomThemeId(obj.id) || seen.has(obj.id)) continue
    const source = sanitizeSource(obj.source)
    if (!source) continue
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : 'Custom theme'
    const tokens = sanitizeTokens(obj.tokens, source.appearance) ?? deriveThemeTokens(source)
    seen.add(obj.id)
    out.push({ id: obj.id, name, appearance: source.appearance, tokens, source })
  }
  return out
}
