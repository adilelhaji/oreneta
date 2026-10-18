# Local patches to tokio-xmpp

This is tokio-xmpp 6.0.0 as published on crates.io, with the changes below.

- **Source:** `tokio-xmpp-6.0.0.crate`, SHA-256
  `8921a165ab1eefd447cb1661423c582ac77b9c6960e123a71c8ad9cebc40b026` (the
  checksum `meron-core/Cargo.lock` held before the patch). Upstream VCS:
  xmpp-rs `1710a6f99edd18cd926a2dc5d14ec532a2a6ad72`, path `tokio-xmpp`
  (`.cargo_vcs_info.json`).
- **Licence:** MPL-2.0 (<https://mozilla.org/MPL/2.0/>). All files in this
  folder, Oreneta's changes included, are under MPL-2.0, not the
  repository's AGPL-3.0. The source stays in this folder; each modified
  place is marked "Patched for Oreneta".
- **Used by:** `meron-core`, through `[patch.crates-io]` in
  `meron-core/Cargo.toml`.

## adilelhaji/oreneta#220: lost wake-up in `StanzaReceiver`

Upstream `StanzaReceiver::poll_next` returned `Poll::Pending` without
registering the waker when `try_lock()` failed because a `StanzaSender` held
the stream lock. The client worker then slept for good and the session
received nothing more while staying connected.

`src/stanzastream/mod.rs`:
- `StanzaReceiver` gets a second field holding a `lock_owned()` future
  (type `Locking`) and a hand-written `Debug`.
- `poll_next`: when `try_lock()` fails, it waits for that future, which wakes
  it once the lock is released.
- `split()` starts it empty; `reunite()` drops it before `Arc::try_unwrap`.

`src/stanzastream/tests.rs`:
- `receiver_polled_during_a_send_is_woken_again` fails with the upstream code
  ("the receiver was never woken") and passes with the patch.
- `a_receiver_waiting_for_the_lock_can_be_dropped_or_reunited`.

Still true after the patch, as upstream: while a sender waits for room in a
full outgoing queue it holds the stream lock, so the receiver waits too (it
is woken once the send ends, no longer lost). `meron-core` bounds that wait
for upload questions (#220, `ask_by` in `meron-core/src/chat/xmpp.rs`).

CI runs these tests (`.github/workflows/test.yml`, job `rust`).

To update tokio-xmpp: replace this folder with the new release, reapply the
changes above if upstream has not fixed the bug, and update the checksum
here and in `docs/soup.md`.
