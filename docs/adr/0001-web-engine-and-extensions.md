# ADR-0001: Keep the native web engine; adopt extension functions as first-party features

- **Status:** Accepted
- **Date:** 2026-09-07
- **Deciders:** Adil El Haji (maintainer)
- **Related:** [ADR-0002](0002-remote-label-linking.md)

## Context

Oreneta is built with [Wails](https://wails.io), which renders the frontend
in each platform's native webview rather than an embedded browser:

| Platform | Engine |
|---|---|
| Linux | WebKitGTK 4.1 |
| macOS | WKWebView |
| Windows | WebView2 (Chromium-based, via `go-webview2`) |

The question was raised: could Oreneta support Google Chrome extensions —
spelling and grammar correction, tracker/ad blocking, translation — the way a
full browser does?

### The coupling to Wails, measured

Before comparing alternatives, the actual dependency on Wails was measured
rather than assumed:

- The frontend talks to the backend through a single generic bridge,
  `window.go.main.App.Invoke(command, payload)` (see
  [`frontend/src/lib/bridge.ts`](../../frontend/src/lib/bridge.ts)), not
  through 200-odd generated bindings. Every one of the 201 `App` methods is
  dispatched through this one call.
- The Go process already treats the Rust engine (`meron-core`) as a sidecar
  over stdio/JSON-RPC (see [`sidecar.go`](../../sidecar.go)), not as a
  library. It is not coupled to Wails at all.
- Wails-runtime calls in the Go layer are limited to file dialogs, the system
  tray, window control, and `BrowserOpenURL` — about a dozen call sites, all
  platform-shell glue rather than architecture.
- Three emitted events (`mailto.open`, `notification-clicked`,
  `update.status`) cross the bridge from Go to the frontend.

In other words: porting the *frontend* and the *Rust engine* to a different
shell would be nearly free. The cost of any engine change is concentrated in
Go's ~4,000 lines of platform glue (tray, notifications, power events, native
dialogs, spell-check activation, the updater) and in re-doing packaging for
four channels (Linux AppImage/deb/snap/flatpak, Windows, macOS DMG, Mac App
Store) plus the Android build, which does not go through Wails at all and is
unaffected either way.

### What Chromium-based extension support actually requires

No native webview (WebKitGTK, WKWebView, or WebView2 as wired through
`go-webview2`) exposes an extension-loading API. The only way to run Chrome
extensions from a Wails app would be Windows-only, by patching
`go-webview2` to reach WebView2's own (still evolving) extensions API — no
equivalent exists on Linux or macOS.

The only way to load extensions on **all three platforms** is to embed
Chromium directly — Electron or CEF — and even then, "full" extension support
does not mean what it means in a browser:

- Electron's own `session.loadExtension()` is aimed at DevTools extensions,
  not general ones: no browser-action popups, no options pages, no Web Store
  install flow.
- The third-party library that fills that gap,
  `electron-chrome-extensions`, implements roughly 70 `chrome.*` API methods
  (`action`, `tabs`, `windows`, `runtime`, `storage`, `contextMenus`,
  `webNavigation`, partial `cookies`/`notifications`/`commands`) but keeps
  background scripts persistently alive rather than truly dormant service
  workers, does not support extensions in non-persistent/incognito sessions,
  and is licensed **GPL-3.0**, with a separate paid patron license required
  for proprietary use (irrelevant to Oreneta, which is AGPL-3.0, but worth
  recording).
- A companion package, `electron-chrome-web-store` (MIT), adds Chrome Web
  Store installation and auto-update, but its README is explicit that its
  preload script must ship unbundled — a packaging constraint of its own.
- CEF's Go bindings are a smaller, less maintained ecosystem, and extension
  support there is partial and being phased out upstream, not expanded.

So "full Chrome extension support" is available at best on Electron, and even
there it is full CEF/Electron extension support, which is itself a subset of
what a real browser offers.

### What embedding Chromium would cost, measured against what Oreneta is today

| | Today (Wails) | With Electron |
|---|---|---|
| Installed size | ~72 MB (28 MB app + 44 MB core) | +~150 MB Chromium runtime |
| Idle RAM | Whatever the OS webview already uses | +150–300 MB |
| Security patch cadence | Follows the OS's WebKit/Edge updates | Oreneta must ship a new build for every Chromium CVE, roughly monthly |
| Mac App Store | Ships today | MAS's sandbox does not permit loading arbitrary extensions; would need a separate, extension-less MAS build or dropping MAS |
| Upstream merges from Meron | Frontend and the Go core logic still merge cleanly | The ~4,000 lines of Go platform glue would fully diverge, since Electron replaces it with its own APIs; Rust and frontend still merge |
| Content-Security-Policy / privacy | `connect-src 'self'`; all data flows through the app's own backend | Each installed extension talks to its own servers; the CSP and the "everything stays on your computer" claim in `README.md` would no longer hold without qualification |
| Packaging | 4 existing scripts (`build.sh`, `build-windows.sh`, `build-mas.sh`, `gen-latest-json.sh`) | Full rewrite on `electron-builder`, re-signing and re-notarizing on every platform |

None of this is disqualifying on its own, but together it changes what kind
of application Oreneta is — the README's tagline is "fast", and the whole
point of forking Meron for native EWS support was to avoid exactly this
category of resource-heavy, IMAP-bridge-style client.

## Decision

**Oreneta keeps its native webview on every platform. It does not embed
Chromium, and it does not host Chrome extensions.**

Instead, the specific *functions* a user would reach for a Chrome extension
to get are adopted as first-party features, built into Oreneta directly,
running locally wherever the function allows it:

| Function | Extension people reach for | Adopted instead | License | Network |
|---|---|---|---|---|
| Grammar and style | Grammarly-style checkers | [Harper](https://github.com/Automattic/harper) (Rust grammar engine), run as WASM inside the TipTap composer | Apache-2.0 | None |
| Tracker/pixel blocking | uBlock Origin and similar | The [EasyPrivacy](https://easylist.to) filter list, applied in Oreneta's existing HTML message sanitizer | GPL-3.0-or-later (dual-licensed with CC-BY-SA-3.0-or-later; GPL-3.0-or-later chosen as the software-compatible option) | None once the list ships with the app; periodic list updates only |
| Translation | Google Translate / DeepL extensions | [Firefox Translations](https://github.com/mozilla/firefox-translations) (the Bergamot engine), run as WASM, per-language-pair models downloaded on demand | MPL-2.0 | Only to fetch a model the first time; translation itself runs offline afterward |

All three licenses were checked against their upstream `LICENSE` file
directly (not asserted from memory) and are compatible with Oreneta's
AGPL-3.0: Apache-2.0 and MPL-2.0 are both explicitly combinable with
AGPL-3.0-covered work by their own terms, and GPL-3.0-or-later is
FSF-recognized as compatible with AGPL-3.0 for a combined work. This is not a
substitute for the maintainer's own legal judgment before shipping, but it is
a checked starting point rather than a guess.

A fourth function, server-backed grammar checking via **LanguageTool**
(LGPL-2.1, to be re-verified when it is actually scoped), is deliberately
left optional and out of this phase: it requires sending message text to a
server, which must be an explicit, per-account opt-in rather than a default,
and is not needed to answer the original request.

Each of these three dependencies gets its own SOUP (Software of Unknown
Provenance) register entry in `docs/soup.md` **when it is actually
integrated**, not in this ADR — the version pinned, the integration point,
and the verification approach belong next to the code that uses them, not in
a decision record written before any of the three exists in the tree.

## Consequences

- No Chrome extension — of any kind, from any store — will ever run inside
  Oreneta. This decision would need to be revisited, not silently reversed,
  if that changes.
- Every future network call these three features make must go through the
  Go/Rust backend, never directly from the frontend, per the existing
  `connect-src 'self'` policy. Translation's one-time model download and any
  future LanguageTool call are the only network paths this ADR anticipates,
  and both must be visible to the user before they happen.
- The Mac App Store build, and the clean merge path from `nonbili/meron`,
  are both preserved.
- Oreneta's installed size, idle memory use, and update cadence stay where
  they are today; none of the Electron costs above are paid.
- If a future requirement genuinely needs a real Chrome extension (not a
  function an extension happens to provide), that requirement conflicts with
  this ADR and must be escalated, not implemented around it.

## Alternatives considered

- **Electron, full extension support** (`electron-chrome-extensions` +
  `electron-chrome-web-store`). Rejected: cost table above, plus Mac App
  Store conflict and GPL-3 dependency requiring a patron license for any
  future closed use.
- **Electron, curated extension allowlist only** (no Web Store, ship a fixed
  set of vetted extensions). Reduces the privacy surface but still pays the
  full size/RAM/patch-cadence/MAS cost for a narrower benefit than adopting
  the functions directly; rejected for the same reasons.
- **Patch `go-webview2` for WebView2's native extensions API, Windows only.**
  Cheap (days, not months) and would give real extensions, but only on one
  of three platforms, and still opens the CSP and privacy questions above.
  Not pursued unless a Windows-specific need is identified later.
- **Do nothing.** Rejected: spelling correction is already native per-OS, but
  grammar, tracker blocking, and translation were genuine gaps worth closing
  — just not through extension hosting.
