# Application screen consistency (#177)

Extends the approved [art direction](art-direction.md) using existing tokens and
components. Delivery under #33/#38; no new theme, dependency or provider behavior.

- Mail, reader, composer, setup, settings, calendar, tasks and Kanban use semantic
  success/warning/danger colors. Accent buttons use the theme's contrasting text.
  Media overlays retain white text on black; account/calendar/label identity
  colors and message content retain their meaning.
- UI-sized Lucide icons use 14/16/20px with 1.75 strokes. Decorative accent glows,
  non-drag hover scaling and non-modal blur are removed. Drag/resize feedback,
  actual dialog backdrops and miniature theme/wallpaper previews are preserved.
- People has a titled search panel and readable contact card. Below 769px, the
  selected card replaces the list; Back restores focus and the existing query.
  Search responses do not move focus. Long names, addresses and notes wrap.
- Task subjects are native buttons, separate from completion/edit/removal.
  Keyboard users can open the conversation; long subjects/notes and due status
  wrap, and action targets remain available in narrow layouts.
- Calendar header controls wrap, view selection exposes its pressed state, and
  previous/next period have localized names. The calendar list remains available
  above the content below 769px. Sync warnings wrap rather than truncate.
- The existing app menu links to People, Tasks, Calendar and the current mail
  workspace. Compact navigation keeps that menu and return-to-mail reachable in
  secondary views. The account rail remains hidden in narrow mail layouts.
- Toasts use readable theme surfaces and composer save errors wrap with an alert
  role; neither change alters when a save/sync is considered successful.

## Verification and limits

Component tests cover contact focus/return/search, independent task actions and
compact navigation/Escape. Production-entry browser checks exercise Spanish long
content, keyboard opening, light/dark, 1440/600px and CSS 200% zoom; screenshots
cover People, Tasks and Calendar. Existing production tests cover shared controls,
mail boundaries, reader, composer, setup, settings and selection. The historical
synthetic baseline also covers Kanban/RSS regressions.

Before evidence was captured from the previous production build. Narrow secondary
screens previously had to be opened at desktop width before resizing because the
hidden rail had no equivalent menu entries. The new checks enter directly through
the compact menu. Calendar after evidence includes a synthetic calendar list.

These are synthetic browser checks, not native WebView, assistive-technology or
provider certification. #33/#38 remain open for full workflow/native acceptance,
offline font packaging and any outstanding screen-specific contracts. Existing
theme/font/density preferences are retained. No installer is replaced.
