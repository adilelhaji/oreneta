# Mail pane boundaries (#85)

Below 769 CSS pixels, mail uses one pane: list or conversation according to the
existing `mobilePane` state. The account rail is hidden; the list's existing menu
and folder switcher remain available. Back returns to the list without closing
the conversation. At 769px and above the saved list width and reader coexist;
the reader may shrink within the remaining space.
Creating a full composer also selects the conversation pane, including keyboard
and mailto entry points; no-sendable-account failure leaves the pane unchanged.
The composer footer wraps its controls within the actual pane width so Send,
Discard and draft status remain reachable even in a narrow desktop split pane.
The full folder navigation
retains its independent >1024px boundary. No resize listener or new state is added.

The previous full-width-list boundary (769px) disagreed with visibility (600px),
leaving the reader clipped at 600–768px. Production tests cover 599/600/601,
768/769 and 1024/1025, both themes, reader/back/selection/folder/composer context,
and shell bounds. The synthetic component baseline now requires visible content
at 600px instead of accepting the known defect.

A 1440px window at 200% zoom is exercised at its equivalent 720 CSS-pixel layout
with device scale 2. The Windows validation runner additionally exercises the
actual WebView2 keyboard path: it verifies foreground focus and injected input,
resets zoom with Ctrl+0, applies the standard Ctrl+plus sequence, and uses
Windows UI Automation to verify the onboarding email editor layout changes while provider choices
and bounds remain visible inside the native window. UI Automation cannot read
WebView2's private `ZoomFactor`, so this is native zoom-layout evidence, not an
exact 200% factor certification. Touch, IME, provider interoperability and
installer behavior remain separate gaps. It does not exercise the mailbox reader,
message actions or composer; those remain separate native acceptance work.
