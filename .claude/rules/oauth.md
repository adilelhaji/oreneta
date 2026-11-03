---
paths:
  - "oauth*.go"
  - "graph_oauth*.go"
  - "docs/oauth-registrations.md"
  - "scripts/ci/inherited-oauth*"
---
A distributable build must not carry Meron's OAuth registrations and must refuse sign-in without Oreneta-owned ones (#144). After a change here, run:

- `go test -tags distributable -run 'OAuth|Distributable' -count=1 .` (on Linux, add the `webkit2_41` tag).
- `node --test scripts/ci/inherited-oauth.test.cjs`.

CI also builds the distributable binary and scans it with `scripts/ci/inherited-oauth.cjs`.

Registering a client or adding credentials is an owner decision.
