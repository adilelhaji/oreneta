# Text-key pagination (#65)

`get_recent_page_sorted` mints a cursor from the exact key returned by its SQL
query. It must not reconstruct that key from displayed sender/subject fields:
SQLite's `lower()` and Rust's Unicode lowercase differ, and trimming a sender
before cursor creation changes the key without changing the SQL ordering.

Keep the existing SQL expression, sender fallback, direction, UID tie-breaker
and `date:`/`sortk:` cursor encoding. The additional selected key is internal;
the message payload and schema are unchanged. This fixes newly minted cursors;
already-issued incorrect keys require reloading the first page.

Regression tests compare complete stable-dataset traversal with the unpaged
query for every key/direction and page sizes 1, 2 and 3. Include repeated/empty,
whitespace-only/padded and non-ASCII names/subjects. This validates message-level
keysets, not grouped-conversation or unified ordering; #30 remains open.

Rust tests run in CI (the current Windows validation host has no Rust toolchain).
