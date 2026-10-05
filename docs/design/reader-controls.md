# Reader controls (#156)

Part of #35, using the existing text-size preference, rendering and composer paths.

- Conversation and standalone readers expose **Message text size**, with 80–400%
  presets and Reset to default (100%). A valid custom value from Settings remains
  available. Changing it uses `message_font_scale`; app-wide text size is unchanged.
  The preference applies across message bodies and survives through the existing
  settings persistence path; it is not a per-message preference.
- Traditional message headers wrap long sender names and addresses. Message
  actions occupy their own row, with direct Forward access through the existing
  composer. Their accessible group name identifies sender and date. Forward is
  unavailable for Graph read-only mail and omitted for drafts/feed items.
- Expand/collapse uses native keyboard buttons with `aria-expanded`. Details and
  message actions remain separate from collapse. Shared icons use semantic colors.

Tests cover custom/boundary/reset values, unchanged application scale, separate
actions/collapse, forwarding the chosen content and read-only restrictions.
Production-entry browser cases cover both cobalt themes at 1440px and 600px:
HTML and plain-body scaling, fixed-width HTML containment, keyboard toggles,
standalone reader controls and screenshots. All mail and bridge responses are
synthetic; native/provider acceptance is separate.

No received content or sanitization/sandbox policy changes. No new printing API,
fit-to-width policy or quote/signature folding. These and complete #35 acceptance
remain open; no executable or installer is replaced by this source change.
