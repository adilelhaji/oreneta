# Art direction

The [mail workflow reference](mail-reference.md) (#32) instantiates this direction
with synthetic, navigable inbox/reader/composer/table/selection/error scenes.
It is a comparison target, not a claim that production already uses the redesign.

A written, checkable reference for what the interface should look like —
the direction every design issue after this one builds against, instead of
each screen re-deriving its own answer.

It exists because a grep of the current tree found what happens without
one: 385 uses of a Tailwind palette class (`rose`, `amber`, `emerald`,
`red`, `white`, `black`) outside the theme's own tokens, 17 accent-tinted
glow shadows, 14 hover/active scale transforms, 20 blur/backdrop-blur uses,
12 distinct icon sizes, 6 stroke widths, and 10 different responsive
breakpoints — none of it wrong in any one place, all of it drift nobody
could see happening one component at a time. The type scale, radii,
elevation and motion durations already tokenised in
[`frontend/src/index.css`](../../frontend/src/index.css) went through the
same problem and the same fix (see the `design:` commits from September
2026) — this page names the steps that haven't been tokenised yet, and the
identity decisions that were never written down anywhere.

## Palette

The app icon (`assets/oreneta.svg`) is a cobalt swallow on navy — `#2E63F0`
and `#15316E` — and the marketing page uses the same blue. The
[cobalt defaults](cobalt-themes.md) implement this palette for new profiles.
Existing Indigo and legacy green selections remain available without palette
rewrites. The target colors are:

| Token | Light | Dark | Use |
|---|---|---|---|
| `accent` | `#2056dd` | `#7ea6ff` | Interactive, selection, the one saturated colour on a screen |
| `bg-sidenav` | `#15316e`-adjacent navy | near-black navy | The account rail |
| Neutrals | Off-white with a faint cool cast, not pure `#fff` | Near-black navy, not pure `#000` | Everything else |

### Semantic tokens

The 385 hardcoded uses above are almost all one of four ideas — success,
warning, danger, informational — expressed as a Tailwind colour name
instead of a token. Add four tokens, one pair of light/dark values each,
to every theme and to the custom-theme editor's derived
output in [`lib/themes.ts`](../../frontend/src/lib/themes.ts):

```
--me-success / --me-success-soft
--me-warning / --me-warning-soft
--me-danger  / --me-danger-soft
--me-info    / --me-info-soft
```

The `-soft` variant is the tint used for a background or a chip; the bare
token is the icon/text/border colour. This mirrors how `accent` /
`accent-hover` already work. Migrating the 385 call sites onto these is a
separate, mechanical issue — the same shape as the 311-call-site migration
the original type-scale tokens went through.

#83 adds these slots to all 16 built-ins and custom palettes, plus
`--me-accent-text` for readable filled controls. Existing hardcoded status-color
call sites still require the separate #33 migration; token availability is not
evidence that every screen has adopted them.

## Type

The six-step scale in `index.css` (`text-2xs` through `text-title`, 10 to
16px) stays as it is — it is right, and nothing here changes it. It stops
at 15px, though, and three places already need more and are improvising:
the calendar's month/period label, the welcome screen's headline, and any
future empty-state title bigger than the current 14px default. Add three
heading steps above the existing scale:

| Token | Size | Use |
|---|---|---|
| `text-heading-sm` | 18px | Section headers inside a Panel (settings groups, calendar sidebar) |
| `text-heading` | 22px | Dialog and screen titles that need more presence than `text-title` (15px) gives — the welcome screen, a full-page empty state |
| `text-heading-lg` | 28px | The one or two places a number or a headline is the point of the screen |

Same rule as the existing scale: nothing on screen is a size that isn't one
of these nine steps now.

## Icons

[Lucide](https://lucide.dev) icons currently ship at 12 different sizes
(7 to 26px) and 6 stroke widths. Reduce to three sizes and one weight:

| Token | Size | Stroke | Use |
|---|---|---|---|
| `icon-sm` | 14 | 1.75 | Inline with `text-caption`/`text-ui`, menu items, row actions |
| `icon-md` | 16 | 1.75 | Buttons, most standalone icons |
| `icon-lg` | 20 | 1.75 | Dialog headers, empty-state marks |

Two exceptions stay outside the scale on purpose, and should stay
undocumented as tokens: the 7px icons inside theme/wallpaper thumbnails,
which are a *drawing* of a 14px icon at thumbnail scale, not a text size;
and any icon whose size is driven by the reader's message-text-size
setting, which follows that setting by definition.

## Elevation

The two existing levels — `shadow-raised` (something lifted off its
surface) and `shadow-overlay` (something floating over the whole page) —
are right in light mode and read poorly in dark mode, where a black shadow
on a near-black background is nearly invisible. Dark mode should express
the same two levels through **surface**, not shadow:

- `shadow-raised` in dark mode: a surface one step lighter than its
  background (already how `--me-bg-raised` works in the default dark
  theme) plus a 1px hairline border at low alpha — not a stronger shadow.
- `shadow-overlay` in dark mode: keep the shadow (a floating layer over
  content genuinely needs the visual separation a shadow gives, even a
  faint one) but pair it with the same hairline border.

This is descriptive, not a new mechanism — it is already how the default
dark theme's `--me-bg-raised` and `--me-border` behave; this page just
names it as the rule so a new theme or a new component follows it on
purpose.

## Motion

Two durations exist — `--duration-fast` (120ms, state changes under the
pointer) and `--duration-base` (200ms, things that appear) — and
`prefers-reduced-motion` already collapses both to zero everywhere. That
stays exactly as it is. What doesn't stay: three effects in current use
that aren't part of this system at all.

### What this app does not do

Named explicitly so it's checkable in review, not just implied:

- **No glow.** `shadow-accent/*` — a coloured shadow used as a highlight —
  does not exist in the two elevation levels above and should not be
  reintroduced. An active/selected state is a tint and a border, not a
  glow.
- **No hover or active scale**, except on genuinely draggable elements
  (a kanban card, a sortable rail item), where scale communicates
  "this is being picked up." A button changes colour on hover; it does not
  grow or shrink.
- **No blur or backdrop-blur** as a decorative halo behind an icon or a
  card. Blur is reserved for an actual overlay backdrop (a dialog behind
  its scrim), which is already a documented `Dialog` behaviour, not a
  per-component effect.
- **No more than three responsive breakpoints.** Ten distinct
  `max-[Npx]` / `min-[Npx]` values exist today; a follow-up issue names
  three (a mobile cutoff, a two-pane cutoff, a three-pane cutoff) as
  `@theme` tokens and migrates every arbitrary value onto them.

## Where this lives

Linked from the command-palette design catalogue
([`DesignCatalogue.tsx`](../../frontend/src/components/dialog/DesignCatalogue.tsx)),
next to the component states it documents — the catalogue shows *what*
exists today; this page says *why* it should look that way and what hasn't
caught up yet.
