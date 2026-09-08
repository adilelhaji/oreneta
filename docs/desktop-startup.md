# Desktop startup verification

The production entry (`src/main.tsx` → `App` → `boot`) must render in a browser
after `bun run build`. Component tests and the synthetic visual baseline do not
exercise this contract and cannot certify that a packaged window starts.

Issue #75 reproduces a Windows startup crash with `useSyncExternalStore` on a
null React dispatcher. A mixed dependency installation resolved app React 19.2.6
and linked-package React 19.2.8 into the same production bundle. Keep React and
React DOM singletons through Vite's documented `resolve.dedupe` contract;
upgrading or replacing the application's state architecture is not required.

Use Bun 1.4.2 and the committed lockfiles. Wails installs with
`bun install --frozen-lockfile`; do not layer another package manager's linked
dependency tree over it. Replace a mixed `node_modules` tree with a fresh locked
installation. This also prevents stale Tiptap/ProseMirror peer copies.

The frontend CI job runs `bun run test:bundler` (production resolution with a
deliberate linked duplicate) and `bun run startup:verify` (build plus browser).
Startup traces/screenshots are uploaded beside baseline evidence.

The production smoke runner serves the actual built assets on loopback. Only
the test injects a Wails transport, with explicit synthetic replies and rejected
unknown commands. No mock transport or test entry ships in the app. Tests must
check console errors, onboarding, reload and navigation with a paused synthetic
account; no provider login, mail transmission or real user data is involved.

This browser check complements the isolated component baseline. Native Windows
verification additionally starts the packaged executable with a temporary
profile and inspects its WebView2-rendered UI. Chromium alone does not certify
the Wails runtime, keyring, provider interoperability or installer behavior.

The Windows release build runs `scripts/test-windows-startup.ps1` before
packaging/publication. Two launches reuse a temporary profile under the existing
development single-instance identity. Windows UI Automation must find the actual
onboarding controls; each launch must separately log embedded-core startup and
a successful account query. Evidence is uploaded even on failure. No debugger
override, real account or production profile is used. This does not test an
installer upgrade or provider authentication.
Native logs remain CI evidence; release publication downloads only the
`oreneta-*` distributable artifacts.

References: [React duplicate runtime diagnosis](https://react.dev/warnings/invalid-hook-call-warning#duplicate-react),
[Vite dependency deduplication](https://vite.dev/config/shared-options.html#resolve-dedupe).
