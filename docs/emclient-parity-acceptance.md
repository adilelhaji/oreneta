# Parity acceptance ledger (#22)

[Machine-readable rows](emclient-parity-acceptance.json) refine the
[roadmap](emclient-parity-plan.md). Scope: S01, the settings-family audit and
rows for delivered domains (calendar, notes, profiles, Graph, POP3, cloud links,
platforms). This is not a completed provider matrix or an assertion of full
settings coverage. #22 remains open for native/provider evidence and detail audit.

The [provider acceptance pack](provider-acceptance.md) (#145/#184) adds a
per-operation report for the existing isolated IMAP/SMTP integration suite and
dedicated live-account procedures. A passing fixture report does not promote
any native/provider ledger row to verified.

## Status summary (2026-10-12)

48 rows: 1 verified, 22 implemented-unverified, 25 partial, 0 absent, 0 unassessed, 0 blocked.
The only verified row (SET-16A) needs neither native nor provider evidence.
No native Windows (N4) or real-provider (N5) evidence exists yet; it is
scheduled once on the final version, so every row that requires it stays at
`implemented-unverified` or below. Rows CAL-01, CAL-02, NOTE-01, ACC-01 and
GRAPH-01 were added on 2026-10-12 for delivered work that had no row.
On 2026-10-15 (#210, ADR-0057) SET-07 gained folder moves on Microsoft Graph
and SET-11 Graph delivery receipts and reading incoming delivery and read
reports; both stay `partial`, since the Exchange (EWS) parts are absent.

| Row | Issue | Section | Status | N | P |
|---|---|---|---|---|---|
| S01-01 | #83 | Appearance/Themes | implemented-unverified | yes | - |
| S01-02 | #83 | Appearance/Themes | implemented-unverified | yes | - |
| S01-03 | #84 | Appearance/Lists; Mail/Conversations | implemented-unverified | yes | - |
| S01-04 | #84 | Appearance/Layout | implemented-unverified | yes | - |
| S01-05 | #85 | Appearance/Layout | implemented-unverified | yes | - |
| S01-06 | #34 | Appearance/Lists | implemented-unverified | yes | - |
| S01-07 | #35 | Mail/Read | implemented-unverified | yes | - |
| SET-01 | #114 | General/Notifications | implemented-unverified | yes | - |
| SET-02 | #114 | General/Shortcuts; Swipe | partial | yes | - |
| SET-03 | #113 | General/Backup; Storage | partial | yes | - |
| SET-04 | #54 | General/Password protection | partial | yes | - |
| SET-05 | #35 | General/Print | partial | yes | - |
| SET-06 | #105 | General/Spell Checker | partial | yes | - |
| SET-07 | #87 | General/Folders | partial | yes | - |
| SET-08 | #33 | Appearance/Toolbars | partial | yes | - |
| SET-09 | #39 | Mail/Replies and Forwards | implemented-unverified | yes | - |
| SET-10 | #88 | Mail/Templates and Signatures; QuickText | implemented-unverified | yes | - |
| SET-11 | #107 | Mail/Privacy; Receipts | partial | yes | - |
| SET-12 | #50 | Mail/Blacklist and whitelist | implemented-unverified | yes | - |
| SET-13 | #112 | Mail/Automatic archiving | implemented-unverified | yes | - |
| SET-14 | #106 | Mail/Translation | implemented-unverified | yes | - |
| SET-15 | #45 | Mail/Watch for Reply | implemented-unverified | yes | - |
| SET-16A | #51 | Mail/Artificial Intelligence | verified | - | - |
| SET-16 | #52 | Mail/Artificial Intelligence | implemented-unverified | yes | - |
| SET-17 | #49 | Signing and Encryption/Policies; Key Lookup Services | partial | yes | - |
| SET-18 | #100 | Calendar/General; Weather | partial | yes | - |
| SET-19 | #41 | Contacts/General | partial | yes | - |
| SET-30 | #53 | Performance/Completion | partial | yes | - |
| SET-31 | #54 | Privacy/Diagnostics; Backup; Updates | implemented-unverified | yes | - |
| SET-20 | #103 | Tasks/General | partial | yes | - |
| SET-21 | #111 | Chat/General | partial | yes | - |
| SET-22 | #109 | Online Meetings/General | partial | yes | - |
| SET-23 | #86 | Widgets/General | partial | yes | - |
| SET-24 | #54 | Advanced/Logging | implemented-unverified | yes | - |
| SET-25 | #112 | Settings/Import and Export | partial | yes | - |
| SET-26 | #116 | Settings/QR Export | partial | yes | - |
| SET-27 | #37 | General/Language | partial | yes | - |
| SET-28 | #29 | Mail/Send; General/Confirmations | implemented-unverified | yes | - |
| SET-29 | #100 | General/Reminders | partial | yes | - |
| S15-01 | #97 | Accounts/POP3 | implemented-unverified | yes | yes |
| S14-01 | #108 | Compose/Attachments | partial | yes | yes |
| S16-01 | #115 | Platforms/macOS and Linux | partial | yes | - |
| S16-02 | #117 | Reference/eM Client 11 | partial | - | - |
| CAL-01 | #102 | Calendar/Invitations | implemented-unverified | yes | yes |
| CAL-02 | #101 | Calendar/Accounts | implemented-unverified | yes | yes |
| NOTE-01 | #104 | Notes/General | partial | yes | - |
| ACC-01 | #99 | Accounts/Profiles; Account groups | implemented-unverified | yes | - |
| GRAPH-01 | #143 | Accounts/Microsoft 365 | partial | yes | yes |

N/P: native/provider evidence required before `verified`. See the JSON for
what is present or missing per row and the exact commit and test file behind
each automated evidence item.

## Provenance and states

The snapshot identifies current main, source page/version, platform, owning issue,
code boundary, current evidence level and a concrete acceptance procedure per row.
S01 uses the existing synthetic fixtures in frontend/baseline/fixtures.ts and the
production entry test in frontend/e2e/startup.e2e.ts. Keep identical content, clock,
timezone, fonts, locale, viewport and appearance for comparable screenshots.
Historical baseline captures do not prove current native/provider behavior.

Rows SET-01 through SET-31 name settings families from the official 10.0
documentation index. On 2026-10-12 each was assessed against the code and its
tests: `present` says what exists and what is missing, and `partial` means part
of the outcome is absent. A planned test is not test evidence.
Each evidence item must name an exact commit and artifact/result URL or repository
path; a verified row requires automated and all applicable native/provider records.

## S01 visual rubric

- 1440px: labelled folder navigation, mail list and reader visible together.
- 1024px: essential folder/account access remains reachable in compact controls.
- 599/600/601px: selected reader is visible with usable back/list navigation;
  compose and actions do not overflow the shell. Check 1024/1025px separately.
- New-profile cobalt tokens follow art-direction.md; saved themes/modes are not
  rewritten. Both appearances preserve readable text, controls and selection.
- Record focus, opened-row, unread and bulk-selection states separately; keyboard
  operation must not select or act on another account's messages.
- Long localized labels/subjects, empty/loading/error states, wide HTML and 200%
  zoom must preserve essential actions. Reduced motion is retained.
- Screen review checks geometry, typography, hierarchy and task completion, not
  a guessed similarity percentage or copied proprietary artwork.

## Updating and validation

Owning PRs update rows only to the evidence level actually obtained. Local browser
runs with a mock Wails bridge are synthetic; native Windows runtime, real account
connectivity and delivery require independent evidence. Add provider-specific
rows rather than relabel a generic test as a provider certification.

CI runs scripts/ci/parity-ledger.test.cjs through the existing workflow-policy job.
It validates references, unique IDs, repository paths, states and required evidence
for verified rows. S01 ends with its actual implementation PRs, not this ledger PR.
