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

The compact app menu also links to People, Tasks and Calendar (#177). Those
surfaces retain the menu and a return to the current mail workspace while the
rail is hidden; their changes are detailed in [screen consistency](screen-consistency.md).

The previous full-width-list boundary (769px) disagreed with visibility (600px),
leaving the reader clipped at 600–768px. Production tests cover 599/600/601,
768/769 and 1024/1025, both themes, reader/back/selection/folder/composer context,
and shell bounds. The synthetic component baseline now requires visible content
at 600px instead of accepting the known defect.

A 1440px window at 200% zoom is exercised at its equivalent 720 CSS-pixel layout
with device scale 2. The Windows validation runner additionally exercises the
actual WebView2 Ctrl+mouse-wheel path: it verifies foreground focus and injected input,
starts at the configured 100% factor, applies wheel zoom in/out, and uses
Windows UI Automation to verify the onboarding email editor layout changes and
remains visible within the native window, while provider choices remain present
in the accessibility tree. UI Automation cannot read
WebView2's private `ZoomFactor`, so this is native zoom-layout evidence, not an
exact 200% factor certification. Touch, IME, provider interoperability and
installer behavior remain separate gaps. It does not exercise the mailbox reader,
message actions or composer; those remain separate native acceptance work.

The 2026-10-06 native run 37429870187 exposed a mismatch in the earlier test:
Wails disables browser keyboard accelerators, including Ctrl+plus/minus/zero.
Those shortcuts remain unsupported ([#181](https://github.com/adilelhaji/oreneta/issues/181));
CSS zoom is not substituted for native zoom.
The validation uses the supported Ctrl+wheel gesture, verifies real growth,
keyboard reachability through vertical scrolling, reduction and restoration,
and repeats after restart. It advances focus once and returns to the email field
before requiring its full bounds inside the window. High zoom need not fit the
entire onboarding form above the fold; a clipped or unreachable editor still
fails. Browser coverage also checks keyboard reachability at 410x280 CSS pixels.
Each launch explicitly
starts at 100%. The keyboard shortcut gap remains separate from installation
acceptance, as do reader/composer and assistive-technology checks.
See [WebView2 zoom](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings#get_iszoomcontrolenabled)
and [browser accelerator behavior](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings3#put_arebrowseracceleratorkeysenabled).
