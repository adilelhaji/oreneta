# Parity acceptance ledger (#22)

[Machine-readable rows](emclient-parity-acceptance.json) refine the
[roadmap](emclient-parity-plan.md). Initial scope: S01 and settings-family audit.
This is not a completed provider matrix or an assertion of full settings coverage.
#22 remains open for the remaining actual-workflow/provider/detail audit.

## Provenance and states

The snapshot identifies current main, source page/version, platform, owning issue,
code boundary, current evidence level and a concrete acceptance procedure per row.
S01 uses the existing synthetic fixtures in frontend/baseline/fixtures.ts and the
production entry test in frontend/e2e/startup.e2e.ts. Keep identical content, clock,
timezone, fonts, locale, viewport and appearance for comparable screenshots.
Historical baseline captures do not prove current native/provider behavior.

Rows SET-01 through SET-29 name less prominent settings families from the official
10.0 documentation index; they deliberately remain unassessed against 10.4 until
their owning issues inspect and test details. A planned test is not test evidence.
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

