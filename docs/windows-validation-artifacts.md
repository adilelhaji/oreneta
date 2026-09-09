# Windows validation artifacts (#131)

Child of #114. Build the existing Wails/Rust application for Windows amd64;
no architecture, signing or update-channel change. Do not dispatch `release.yml`
for validation: its manual path also publishes a public release.

`windows-validation.yml` is an explicit CI-only build with read-only repository
permissions. Check out the dispatch SHA, require its completed seven-job main
CI through the existing release-gate policy (without a tag requirement), then
build locked Rust/Bun dependencies, the embedded sidecar and NSIS installer.
Never substitute a newer branch checkout for the checked commit.

The existing isolated native startup/restart test must pass and find the Graph
account choice. No sign-in, real mailbox or existing user profile is used.
Upload diagnostics even on failure; upload canonical `oreneta.exe` and
`oreneta-amd64-installer.exe` only after native validation succeeds. A JSON
manifest binds both SHA256 hashes to the full source SHA and workflow run.

This pipeline creates CI artifacts, never tags, releases, updater manifests or
store submissions. It does not certify account-provider interoperability,
installer upgrade/uninstall, signing, other architectures or eM Client parity.
After download, verify both hashes and source SHA before replacing local output.
Retire only superseded application binaries to the Recycle Bin after successful
replacement verification; defer locked files/unsaved sessions. Keep evidence
separate from the canonical binary directory.

Automated policy tests cover dispatch-only execution, exact checkout/gate,
read-only permissions, locked builds, native-before-artifact ordering,
failure evidence and absence of publication. CI plus the dispatched native
build are separate required evidence; a workflow definition alone is not a
validated executable.
