# IMAP IDLE acceptance (#121)

`watch.start` acknowledges scheduling, not readiness. Its asynchronous catch-up
emits `mail.synced` even for an empty watched folder. Integration acceptance
captures the event count before starting and waits for that initial event before
appending the synthetic message. Each event wait has a 60-second deadline.

The later push must emit another event and put the specific message in the cache;
the assertion uses `messages.recent(refresh:false)`, never a manual refresh.
The existing watcher-stop/no-further-push assertions remain unchanged. CI runs
the full real-sidecar/Maddy suite and repeats the IDLE case three times.

This removes an initial-event race observed in PR #120, run 34326510250 attempt 1.
It does not change the watcher implementation or certify external providers.
