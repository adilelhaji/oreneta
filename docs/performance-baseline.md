# Reproducible performance baseline

Issue #53 establishes a deterministic dataset and report contract before any
virtualization or benchmark dependency is proposed.

## Dataset contract

`node scripts/perf/mail-dataset.mjs --sizes 1000,10000,100000` generates the
same message metadata for every run. The generator is side-effect free and
does not contact a provider. Each report records the requested sizes, SHA-256
of the canonical dataset, commit, Node/runtime, platform and cache state.

## Measurements

The first slice measures dataset generation, stable sort and sender filtering
separately. These are deterministic workload indicators, not UI p95 claims.
Cached first-page, downloaded-message opening, startup, scrolling and retained
memory require the reference Windows device and remain open acceptance work.
No threshold is committed until repeated native measurements calibrate it.

## Reproduction

```text
node scripts/perf/mail-dataset.mjs --sizes=1000,10000,100000 --output=perf-report.json
node --test scripts/perf/mail-dataset.test.mjs
```

Reports are local evidence unless attached to a CI/native run with the exact
commit and environment. Synthetic data must never be presented as provider or
native acceptance.
