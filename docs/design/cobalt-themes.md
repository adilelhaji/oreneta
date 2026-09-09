# Cobalt defaults (#83)

New profiles use `oreneta-light` or `oreneta-dark`, matching the accepted
[art direction](art-direction.md) and [mail reference](mail-reference.md).
First launch chooses the OS appearance when available, otherwise light.
The resulting cached choice is explicit: later OS changes do not override it.
Continuous system-following is not introduced by this slice.

The 14 previous theme IDs and their palette colors remain available. The green
`light`/`dark` entries are displayed as Legacy Green/Legacy Green Dark to avoid
confusing them with the new cobalt defaults. Existing DB preferences remain
authoritative over the bootstrap cache; no bulk preference rewrite is performed.
Users select Oreneta Light/Dark explicitly in Settings > Theme to adopt them.
Deleting an active custom theme returns to the matching appearance's default.

All built-ins and newly derived custom themes expose success/warning/danger/info
foreground/soft tokens and an accent-text token. Old custom palettes retain
every stored token; missing semantic slots are filled without regenerating their
colors. Missing accent text is derived from the saved accent, including pale
legacy custom accents. New custom palettes also derive it from opaque sRGB contrast;
transparent custom accents require a resolved background and are not certified.
Explicitly saved accent-text colors stay unchanged. Migrating hardcoded status colors
throughout the UI remains #33, not part of this default-palette slice.

CSS fallback tokens match the two default registry palettes. Filled legacy
`bg-accent text-white` controls use the accent-text token: the pale dark cobalt
accent requires dark text; legacy accents also use a contrasting foreground without
changing the accent itself. The active theme's
`.dark` class continues to control Tailwind variants and native `color-scheme`.

Verification: unit checks cover token completeness, CSS/registry consistency,
opaque contrast, legacy custom token retention, all built-in IDs, hydration,
explicit selection, deleted/unknown custom IDs and first-launch appearance.
Production-entry tests cover both new themes, existing Indigo, a saved legacy
custom palette, explicit picker selection, reload and OS changes. Screenshots
at 1440/1024/600 use synthetic bridge data, not native/provider certification.
The reader/list defaults and the known 600px reader defect remain #84/#85.
