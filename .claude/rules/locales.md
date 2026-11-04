---
paths:
  - "locales/**"
  - "scripts/i18n/**"
---
- `locales/*.json` is the source of truth. The files generated from it are gitignored and are overwritten: never edit them (the `protect-paths` hook blocks it).
- After any change here: `bun run i18n:validate && bun run i18n:generate`, then `bun run test:i18n`.
- A change to `locales/ca.json` goes through `catalan-reviewer` before the push.
