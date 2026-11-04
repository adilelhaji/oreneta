---
paths:
  - "docs/adr/**"
  - "docs/design/**"
  - "docs/emclient-parity-acceptance.*"
---
- An ADR carries its status and date at the top. The owner accepts it: never write one as accepted unless the owner said so, and record when and how they did.
- A change to `docs/adr/` or `docs/design/` goes through `catalan-reviewer` before the push.
- In the parity ledger, keep the `.md` and the `.json` in step and run `node --test scripts/ci/parity-ledger.test.cjs`.
