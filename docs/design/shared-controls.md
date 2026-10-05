# Shared controls and feedback

Delivery: [#152](https://github.com/adilelhaji/oreneta/issues/152), a bounded part of
[#33](https://github.com/adilelhaji/oreneta/issues/33). Uses the existing
[art direction](art-direction.md), theme tokens and native bridge.

## Delivered behavior

- Buttons use readable `on-accent` text and semantic danger colors. Hover changes
  color without scaling or glow; disabled controls remain inert.
- Shared icons use 14/16/20px at stroke 1.75. Decorative icons are hidden from
  assistive technology. The type scale includes 18/22/28px heading steps.
- Invalid fields expose `aria-invalid` and retain the global keyboard focus ring.
- A chip that can be selected and removed has two sibling buttons. Keyboard and
  pointer removal cannot also select it; callers must provide a removal label.
- Menu labels, buttons and notices wrap long text. Empty, loading and error states
  share a quiet layout while retaining distinct roles and explicit retry actions.
- The command palette's **Open design catalogue** shows these states, including
  disabled controls, long Spanish text and an operable link to the art direction.

## Evidence and limits

`design-primitives.test.tsx` covers disabled actions, input descriptions, chip
semantics, feedback roles and catalogue actions. The production-entry browser
suite covers light/dark at 1440px and 600px, keyboard focus, reduced motion,
selection/removal, long labels and the documentation link. It saves controls and
feedback screenshots in the CI startup evidence artifact.

These browser tests use a strict synthetic native bridge. They do not certify
real providers, native WebView behavior, every theme, or full accessibility.
The broader #33/#37 acceptance stays open: remaining screen-specific colors and
icons, modal focus containment/restoration, native zoom and assistive-technology
checks still need their own evidence. No executable or installer is replaced by
this source change.

[#177](screen-consistency.md) extends the tokens, icon scale and restrained effects
to application call sites and improves the narrow secondary screens. Native and
complete workflow acceptance remains separate.
