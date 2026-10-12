# EasyPrivacy snapshot (#107, ADR-0029)

`easyprivacy.txt` is EasyPrivacy as published by the EasyList authors,
assembled from `easyprivacy.template` of
[easylist/easylist](https://github.com/easylist/easylist) at commit
`4b79596e08b73b59f3a7635f6907b824825db191` (2026-10-12T14:18:19+13:00). The
template's `%include` lines were replaced by the files they name, and two
comment lines record the commit. Nothing else was changed.

- SHA-256 of the file as committed:
  `a510039130785ff8db92b6ca826f7ad406fa121a079bafb172348cc657a320f0`.
- **Licence:** EasyList and EasyPrivacy are dual-licensed under GPL-3.0-or-later
  and CC BY-SA 3.0 or later (see the list's own header); both are compatible
  with shipping it alongside this AGPL program.
- **Updates:** the person can ask for the current list from
  `https://easylist.to/easylist/easyprivacy.txt`. It is checked (title,
  size, rule count) before it replaces this one, and a failed update keeps
  the list there was.
- **Replacing this snapshot:** assemble it the same way, record the commit
  and hash here, and keep `privacy/tests.rs` passing. A test is never
  changed to fit a new list without saying why.
