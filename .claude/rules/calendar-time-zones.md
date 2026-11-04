---
paths:
  - "meron-core/src/calendar/**"
  - "meron-core/src/pim/reminders*"
  - "meron-core/src/pim/reminders/**"
  - "frontend/src/lib/agenda*"
  - "frontend/src/lib/dayPanel*"
  - "frontend/src/lib/calendarDrag*"
  - "frontend/src/components/chat/SidebarAgenda*"
  - "frontend/src/components/chat/SidebarDay*"
---
All-day dates and instants coincide in UTC, so a test can pass there and still be wrong. CI runs these tests in other time zones too; run them the same way before you push. `scripts/comprobar.sh` does.

- Engine: `TZ=Asia/Tokyo`, `TZ=America/Los_Angeles` and `TZ=Pacific/Auckland`, with `cargo test --manifest-path meron-core/Cargo.toml --lib -- calendar:: pim::reminders::`.
- Agenda and day panel: `TZ=America/Sao_Paulo` and `TZ=Australia/Sydney`.
- Dragging events across a clock change: `TZ=Europe/Madrid`, with `bun test src/lib/calendarDrag.test.ts`.
