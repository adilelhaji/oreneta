# eM Client parity delivery plan

Date: 2026-09-09. Created: 13 milestones, 35 new issues; 34 existing issues
reused including the program; 2 closed without deleting history.

Program: [#21](https://github.com/adilelhaji/oreneta/issues/21).
Execution inventory: [backlog manifest](emclient-parity-backlog.json).
Acceptance cases and current evidence: [versioned ledger](emclient-parity-acceptance.md).
This replaces the **scheduling and scope** of the old internal-pilot plan, not its
unresolved safety requirements. Planning does not approve new architecture.

## Target and honest completion language

The frozen first reference is **eM Client 10.4.5674.0 for Windows**, released
2026-08-14. The newer **11.0.282.0 (2026-09-03) is beta**, tracked separately.
Source: [official Windows release history](https://www.emclient.com/release-history?os=win).
At each sprint boundary compare changes with the reference; version the matrix
and file deltas, rather than silently moving the current sprint's finish line.

Deliver comparable **user outcomes and interaction quality**, not proprietary
source, branding, assets, infrastructure or the same rendering engine.
Keep Oreneta's accepted cobalt/navy identity and native Wails/Go/Rust/React stack.
A different internal implementation is acceptable only if externally observable
behavior and limitations are explicitly tested and documented.

First acceptance claim: "Windows desktop parity against the frozen matrix".
macOS desktop needs its own native evidence. Linux remains supported by Oreneta's
existing regression obligations. Mobile is a distinct product/platform matrix;
this plan does not authorize a new mobile architecture or claim universal parity.
Paid eM features remain in the comparison, even if Oreneta exposes them differently.
Vendor-specific hosted services need a documented equivalent/decision; omitting
one does not become "full parity". Architecture refusal or an approved deferral
means **partial parity**, with the remaining gap visible.

## Starting evidence, not an implementation percentage

Baseline for this plan: remote main
`100976d423258eb302bcc903c9c059838666e40c` (PR #82).
[Historical baseline](baseline.md) records older evidence and must not be read as
the current completion ledger.

- PR #81 delivered a navigable synthetic reference, not a real mail client.
- PR #82 integrated real account/folder navigation above 1024px, not the full redesign.
- Production defaults still use Indigo, cards and chat-style conversations.
- The 600px offscreen-reader defect remains characterized, not fixed.
- IMAP/SMTP/MIME, EWS, contacts, local linked tasks and crypto have implementations;
  independent provider/native-platform assurance remains incomplete.
- Local attachment/template commits `7427383`, `142a007`, `f4d19e9` remain on
  the user's local main. #40 must reconcile them without discarding changes or
  counting them as delivered before a reviewed PR and green CI.
- The existing Windows executable predates #81/#82; no new executable is produced
  by this planning change.

Status vocabulary per capability/platform/provider: **unassessed**, **absent**,
**partial**, **implemented-unverified**, **verified**, **blocked**. Only verified
counts toward parity. A mock, screenshot, merged PR or compiled binary alone
cannot establish an entire capability. Do not infer absence just from a search.

## Traceable capability matrix

The owning issue must refine each row into versioned acceptance cases, citing
the reference behavior, code entry points, provider limits and evidence SHA.
This is the complete workstream inventory, not a claim that every micro-feature
has already been reverse-engineered. #22 owns the settings/menu/provider audit;
newly discovered requirements must get an issue before the ledger is accepted.

| Capability | Required outcomes | Owning issues | Current status |
|---|---|---|---|
| C01: Identity and shared design | Cobalt themes, semantic tokens, typography, icons, menus, forms, contrast, no decorative drift | [#8](https://github.com/adilelhaji/oreneta/issues/8) → [#33](https://github.com/adilelhaji/oreneta/issues/33); [#83](https://github.com/adilelhaji/oreneta/issues/83) | partial |
| C02: Mail workspace | Conventional initial list/reader, persistent panels, density, keyboard, narrow/zoom behavior | [#32](https://github.com/adilelhaji/oreneta/issues/32), [#33](https://github.com/adilelhaji/oreneta/issues/33), [#34](https://github.com/adilelhaji/oreneta/issues/34), [#35](https://github.com/adilelhaji/oreneta/issues/35), [#36](https://github.com/adilelhaji/oreneta/issues/36); [#84](https://github.com/adilelhaji/oreneta/issues/84); [#85](https://github.com/adilelhaji/oreneta/issues/85) | partial |
| C03: Folder operations | Real hierarchy, favorites, colors, management, safe moves and selections | [#27](https://github.com/adilelhaji/oreneta/issues/27), [#34](https://github.com/adilelhaji/oreneta/issues/34); [#87](https://github.com/adilelhaji/oreneta/issues/87) | partial |
| C04: Reader | HTML/plaintext, quotations, images, per-message actions, body zoom and scoped printing | [#35](https://github.com/adilelhaji/oreneta/issues/35) | partial |
| C05: Context | Agenda, invitations, contact communication/file history with origin and coverage | [#86](https://github.com/adilelhaji/oreneta/issues/86) | unassessed |
| C06: Lists | Global order, stable pagination, configurable columns, saved layout and selection semantics | [#30](https://github.com/adilelhaji/oreneta/issues/30), [#36](https://github.com/adilelhaji/oreneta/issues/36) | partial |
| C07: Compose | Account/alias, recipients, rich text/tables/images, spellcheck, drafts, attachments and recovery | [#39](https://github.com/adilelhaji/oreneta/issues/39), [#40](https://github.com/adilelhaji/oreneta/issues/40); [#88](https://github.com/adilelhaji/oreneta/issues/88) | partial |
| C08: Sending | Accepted versus unknown outcomes, Sent archival, scheduling, undo delay and follow-up | [#29](https://github.com/adilelhaji/oreneta/issues/29), [#45](https://github.com/adilelhaji/oreneta/issues/45); [#89](https://github.com/adilelhaji/oreneta/issues/89) | partial |
| C09: Personalized mail | Reviewed recipient-specific messages and accurate partial outcomes | [#90](https://github.com/adilelhaji/oreneta/issues/90) | unassessed |
| C10: Search | Operators, visual filters, account/folder scopes, saved live views and partial coverage | [#31](https://github.com/adilelhaji/oreneta/issues/31), [#43](https://github.com/adilelhaji/oreneta/issues/43) | partial |
| C11: Filing | Categories, local/remote labels, flags, message annotations, reversible actions | [#91](https://github.com/adilelhaji/oreneta/issues/91); [#95](https://github.com/adilelhaji/oreneta/issues/95) | unassessed |
| C12: Automation | Local/server rules, spam correction, macros, vacation/forwarding where supported | [#48](https://github.com/adilelhaji/oreneta/issues/48), [#50](https://github.com/adilelhaji/oreneta/issues/50); [#92](https://github.com/adilelhaji/oreneta/issues/92); [#94](https://github.com/adilelhaji/oreneta/issues/94) | partial |
| C13: Files | All-attachments search, previews, save/source links, bounded indexing | [#40](https://github.com/adilelhaji/oreneta/issues/40); [#93](https://github.com/adilelhaji/oreneta/issues/93) | partial |
| C14: Accounts | Email-first discovery, OAuth/manual recovery, service capability display, groups/profiles | [#96](https://github.com/adilelhaji/oreneta/issues/96); [#99](https://github.com/adilelhaji/oreneta/issues/99) | partial |
| C15: Protocols/providers | IMAP/SMTP, POP3, Gmail/Workspace, Outlook/M365, EWS on-prem, iCloud and listed service variants | [#46](https://github.com/adilelhaji/oreneta/issues/46), [#47](https://github.com/adilelhaji/oreneta/issues/47), [#48](https://github.com/adilelhaji/oreneta/issues/48); [#97](https://github.com/adilelhaji/oreneta/issues/97); [#98](https://github.com/adilelhaji/oreneta/issues/98) | partial |
| C16: Calendar | Views/editing, recurrence, timezones, sync, subscriptions, reminders and search | [#100](https://github.com/adilelhaji/oreneta/issues/100); [#101](https://github.com/adilelhaji/oreneta/issues/101) | partial |
| C17: Scheduling | Invitations/updates/cancellations, free/busy, delegated and read-only behavior | [#102](https://github.com/adilelhaji/oreneta/issues/102) | unassessed |
| C18: People | Detailed fields, groups, safe deduplication, editing, import/export, provenance/history | [#28](https://github.com/adilelhaji/oreneta/issues/28), [#41](https://github.com/adilelhaji/oreneta/issues/41); [#86](https://github.com/adilelhaji/oreneta/issues/86) | partial |
| C19: Tasks | Existing linked-task recovery plus standalone lists, recurrence, reminders, delegation and sync | [#42](https://github.com/adilelhaji/oreneta/issues/42); [#103](https://github.com/adilelhaji/oreneta/issues/103) | partial |
| C20: Notes | Standalone rich notes, tags/files/search, local and supported server sync | [#104](https://github.com/adilelhaji/oreneta/issues/104) | unassessed |
| C21: Crypto | Signing/encryption/decryption, key import/export/discovery policy and truthful trust states | [#9](https://github.com/adilelhaji/oreneta/issues/9), [#12](https://github.com/adilelhaji/oreneta/issues/12), [#49](https://github.com/adilelhaji/oreneta/issues/49) | partial |
| C22: Privacy | Unsafe content isolation, tracker blocking, secrets, consent and diagnostic redaction | [#54](https://github.com/adilelhaji/oreneta/issues/54); [#107](https://github.com/adilelhaji/oreneta/issues/107) | unassessed |
| C23: Language | Offline grammar and translation, honest language coverage and packaged models | [#105](https://github.com/adilelhaji/oreneta/issues/105); [#106](https://github.com/adilelhaji/oreneta/issues/106) | unassessed |
| C24: Assistant | Explicit-context generation, revision/tone, summary and reviewed extraction, no autonomous mail actions | [#51](https://github.com/adilelhaji/oreneta/issues/51), [#52](https://github.com/adilelhaji/oreneta/issues/52) | partial |
| C25: Integrations | Cloud sharing and meeting lifecycle across the published provider inventory | [#108](https://github.com/adilelhaji/oreneta/issues/108); [#109](https://github.com/adilelhaji/oreneta/issues/109) | unassessed |
| C26: Chat | Direct/group/channel chat, supported presence/history/files and account isolation | [#110](https://github.com/adilelhaji/oreneta/issues/110); [#111](https://github.com/adilelhaji/oreneta/issues/111) | unassessed |
| C27: Portability | Legacy imports, standard exports, local archives/data files, profiles and scheduled complete backups | [#25](https://github.com/adilelhaji/oreneta/issues/25); [#112](https://github.com/adilelhaji/oreneta/issues/112); [#113](https://github.com/adilelhaji/oreneta/issues/113) | unassessed |
| C28: Desktop operations | Notifications, shortcuts, touch, mailto/default app, proxy/TLS, printing, DPI/IME, install/update/recovery | [#37](https://github.com/adilelhaji/oreneta/issues/37); [#114](https://github.com/adilelhaji/oreneta/issues/114); [#115](https://github.com/adilelhaji/oreneta/issues/115) | partial |
| C29: Completion | Performance, accessibility, native E2E, current artifacts, remaining limitations and support | [#37](https://github.com/adilelhaji/oreneta/issues/37), [#53](https://github.com/adilelhaji/oreneta/issues/53), [#54](https://github.com/adilelhaji/oreneta/issues/54), [#55](https://github.com/adilelhaji/oreneta/issues/55); [#114](https://github.com/adilelhaji/oreneta/issues/114); [#115](https://github.com/adilelhaji/oreneta/issues/115) | partial |
| C30: Later-version/platform deltas | v11 beta and mobile separately scoped and tested | [#117](https://github.com/adilelhaji/oreneta/issues/117); [#116](https://github.com/adilelhaji/oreneta/issues/116) | unassessed |

Reference sources (retrieved 2026-09-09): [overview](https://www.emclient.com/features-overview),
[email](https://www.emclient.com/features-email),
[calendar/tasks](https://www.emclient.com/features-calendar),
[contacts](https://www.emclient.com/features-contacts),
[notes](https://www.emclient.com/features-notes),
[chat](https://www.emclient.com/features-chat),
[email services](https://www.emclient.com/email-services),
[cloud storage](https://www.emclient.com/cloud-storages),
[meeting providers](https://www.emclient.com/online-meetings-tools).
Marketing pages can mix versions; reconcile uncertain items against stable
release notes/settings before labelling a capability mandatory for 10.4.
Provider-specific/less prominent settings (weather, shortcuts, sounds, signatures,
archive/import variants, key discovery, task capabilities) remain explicit audit
rows under #22; they cannot disappear behind a broad "other" completion checkbox.

## Sprint roadmap and dependency order

GitHub milestones are the sprint containers. Only **S01** is the active candidate;
S02–S12 are ordered delivery backlogs, **not promises of one sprint each**.
S13 is a separate discovery queue. Use two-week execution timeboxes when capacity
is known; split a large milestone into bounded iterations rather than rushing
a multi-provider epic into one PR. No invented assignees, velocity or due dates.

| Sprint | Outcome | Entry / exit |
|---|---|---|
| [S01](https://github.com/adilelhaji/oreneta/milestone/1) | First real visual change | #22 + theme, mail-default, narrow; actual light/dark app, old preferences intact |
| [S02](https://github.com/adilelhaji/oreneta/milestone/2) | Integrity and recovery contracts | Reproduce #27–#29; approve only needed #24/#25 decisions; failure cases pass |
| [S03](https://github.com/adilelhaji/oreneta/milestone/3) | Complete mail shell and reader | #30, #32–#36, folders/sidebar; real complete workflow, not prototype alone |
| [S04](https://github.com/adilelhaji/oreneta/milestone/4) | Compose and reliable delivery | #39/#40/#45, libraries, scheduling and mail merge; restored drafts and exact outcomes |
| [S05](https://github.com/adilelhaji/oreneta/milestone/5) | Organization and search | #31/#43/#50, categories/local rules/macros/labels/files; full query scope and safe mutations |
| [S06](https://github.com/adilelhaji/oreneta/milestone/6) | Accounts/provider continuity | #46–#48, onboarding/profiles/POP3/provider certification; approved adapters and evidence |
| [S07](https://github.com/adilelhaji/oreneta/milestone/7) | Calendar | Views, recurrence, provider sync and invitations verified end to end |
| [S08](https://github.com/adilelhaji/oreneta/milestone/8) | Personal information | #28/#38/#41/#42, full tasks and notes; approve model changes first |
| [S09](https://github.com/adilelhaji/oreneta/milestone/9) | Security/languages | #9/#12/#49 plus ADR-0001 tools; independent crypto and privacy tests |
| [S10](https://github.com/adilelhaji/oreneta/milestone/10) | Integrations/assistant/chat | #51/#52, cloud/meetings/chat; consent, isolation and provider-specific acceptance |
| [S11](https://github.com/adilelhaji/oreneta/milestone/11) | Windows complete acceptance | #25/#53/#54, migration/backup/native Windows artifacts; all stable Windows rows verified |
| [S12](https://github.com/adilelhaji/oreneta/milestone/12) | Desktop cross-platform | #37/#55 and macOS; native evidence and controlled acceptance; no automatic public rollout |
| [S13](https://github.com/adilelhaji/oreneta/milestone/13) | Beta/mobile discovery | Record deltas and decisions independently of the stable desktop gate |

Dependencies are per capability, not rigid waterfall prerequisites:
#46 Exchange continuity discovery starts immediately; #9/#12 and any reproduced
P0 integrity/security issue may preempt S01. #37/#53/#54 checks apply to every
delivery even though their closing milestones are later. Calendar/task/notes/chat
architecture discovery should happen early enough to avoid idle implementation.
The manifest separates nonblocking `relatedIssues` from hard `blockedBy`
dependencies. Architecture approval is a separate gate; an approved design does
not require its entire umbrella issue to close. Missing-provider server rules
are scheduled in S06 after delegated/server capability validation, not in S05.
Every item has an issue URL, sprint, initial status and evidence statement;
`unassessed` is intentionally not a claim of absence or implementation.

### S01 execution slices

1. **[#22](https://github.com/adilelhaji/oreneta/issues/22), acceptance ledger** (S): audit current defaults/reference, identify exact
   baseline SHA, screenshots and pending gaps; do not require recruiting a pilot.
2. **[#83: theme](https://github.com/adilelhaji/oreneta/issues/83)** (M): implement documented new-profile default, preserve persisted
   choices/custom themes, test light/dark/system and refresh/restart.
3. **[#84: mail-default](https://github.com/adilelhaji/oreneta/issues/84)** (M): reuse supported conventional modes, preserve explicit old
   selections, offer a deliberate switch; test reading/replying and bulk selection.
4. **[#85: narrow](https://github.com/adilelhaji/oreneta/issues/85)** (S/M): reproduce 600px cutoff, correct shared layout condition and
   test adjacent widths/zoom without masking other reader failures.

Sizes are relative only: S = one bounded concern, M = several existing-component
interactions, L = split before implementation; architecture/provider epics remain
unestimated until discovery. For the first timebox commit only ready slices that
fit measured capacity; carryovers remain open. No claim of a 26-week finish.

S01 acceptance package: PRs + actual tested SHA + automated result links +
production-entry screenshots at 1440/1024/600 and boundary widths, light/dark +
preference migration/restart checks. Native Windows verification is separately
required before presenting a newly built executable as the validated update.
S01 does not close the entire design epic or claim functional parity.

## Architecture decision queue

| Gate | Required decision before affected implementation |
|---|---|
| #24 / #25 | Changed identity, wire compatibility, durable ownership, migrations and recovery contracts |
| #46 → #125 → #127/#128; #47 delegation | Graph direction approved in [ADR-0004](adr/0004-microsoft-graph.md) on 2026-09-09; incremental native adapter, explicit per-account adoption, preserved IMAP/SMTP/EWS local. Exact slice contracts documented before code; exposure/provider acceptance still open. |
| pop3 / profiles | POP3 retention/identity and profile isolation if missing from current contracts |
| tasks-full | Standalone/synced tasks conflict with current local, one-open-task-per-thread contract |
| notes | Standalone note storage, identity and note-capable provider semantics |
| chat-design → chat | Native adapter boundary, history/presence/files, scopes and maintenance |
| #51, #52, cloud, meetings | External destinations, consent, credentials, retention/cost and supported APIs; #51 provider/context boundary and #52 result-review contract accepted in [ADR-0006](adr/0006-assistant-provider-context-privacy.md) and [ADR-0007](adr/0007-assistant-results-review-and-cancellation.md) on 2026-09-10 |
| migration / backup | New data formats/dependencies, archive model and consistent snapshot/encryption policy |
| beta-delta / mobile-scope | New sync service, MCP/Matrix or new platform architecture |

Discovery can produce options and tests, not silently choose an architecture.
On encountering a required decision: stop the affected implementation, ask the
human a concrete question, document approval in an ADR **before** writing code.
Existing ADR-0001/0002/0003 stay binding. Grammar/translation/tracker functionality
already has an accepted direction; do not reopen it or introduce a cloud shortcut.
No service subscriptions, credentials borrowing, production rollout or public
release are authorized by creating these issues.

## Issue workflow and definition of done

- Refresh main; reconcile issue, current code, docs and local work before coding.
- Scope a reviewable slice; parent epics close only when all child requirements pass.
- Update concise documentation with code; architecture documentation comes first.
- Tests cover success, boundary, error, interruption/recovery, isolation and
  regressions. Add provider integration and native E2E where relevant.
- Lightweight logic and business reviewers independently review every implementation;
  resolve findings, open PR, require green checks for the delivered SHA, merge with
  a **merge commit** and take the next ready issue without another permission prompt.
- Changes to infrastructure/build are declarative CI/CD work. Validation is not
  permission to publish or to send real mail.
- Attach screenshot evidence for visual changes from production UI; mock bridge
  evidence is marked synthetic and cannot replace native/provider tests.
- A release gate includes source SHA, checksums, signing/provenance policy, install,
  update, rollback/recovery and known limitations. Retire old local binaries only
  after the canonical replacement passes validation, following AGENTS.md.

An item is verified only when its acceptance cases, tests, docs, reviews, merge
and applicable native/provider evidence are linked. "Deferred", inaccessible
test accounts, missing devices, unresolved defects and unavailable services
remain gaps, not passed tests. Never promise zero production errors.

## Backlog cleanup policy and disposition

Inventory: 36 open issues, no open PRs or milestones at planning intake.
Reuse #21 as the parity umbrella and #22 as the acceptance ledger.
Retain the other 32 relevant execution issues: safety, performance, migration,
accessibility and release evidence are prerequisites, not unrelated work.

- **#8**: consolidate its outstanding design-catalogue documentation link into
  #33, then close as not planned/duplicate, explicitly **not implemented**.
- **#44**: close as not planned for this scope: optional people/service grouping
  is not the same as eM inbox categories. Preserve the issue/history and existing
  code; the categories issue owns the actual parity requirement.
- **#38**: retain parity screens; exclude new Kanban-specific enhancements.
  Existing Kanban/RSS/mobile behavior remains regression-protected, not deleted.
- **#55**: retain support and acceptance evidence; real participant enrollment and
  public rollout remain separately authorized.
- **#9**: repair the empty body with the title's security requirement, reproduction
  work and independent tests; do not close a crypto bug as unrelated.

No permanent issue deletion, deletion of code/data or closure of unresolved
security findings. Every closure records its reason/replacement before closing.
The old E0–E8 schedule and repeated permission requests in legacy issue text are
superseded by this plan and the current user-authorized workflow; acceptance and
architecture constraints remain unless explicitly reconciled in the issue.
