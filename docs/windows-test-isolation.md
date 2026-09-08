# Cross-platform desktop tests

Issue #76: filesystem tests must never use a real user profile. The shared test
fixture sets `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, redirects XDG data,
state/runtime paths and clears inherited XDG config/cache and development-profile
overrides. Each test gets separate temporary config and
cache roots using the host OS convention. Media, avatar, wallpaper, updater and
sidecar tests use this fixture. Production path selection is unchanged.
Environment fixtures must not run with `t.Parallel()`.

XDG assertions apply on Linux; Windows/macOS must retain their native directory
conventions even when XDG overrides exist. Foreign-OS update-channel fixtures
expect paths normalized by the host filesystem API. Symlink coverage is skipped
only for Windows error 1314 (missing symlink privilege), never for other errors.

CI runs the full Go suite on Windows in addition to Linux. The release quality
gate requires the `go-windows` job on the exact main commit. Native executable
startup and restart remain separate release-build checks documented in
[desktop startup](desktop-startup.md).
