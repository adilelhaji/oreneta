#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit). Exit code 2 blocks writing secrets and the
# localization files generated from locales/ (see .gitignore).
# For a deliberate exception, the owner exports ORENETA_ALLOW_PROTECTED=1.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
path="$(bash "$here/read-field.sh" .tool_input.file_path)"
[ -z "$path" ] && exit 0
[ "${ORENETA_ALLOW_PROTECTED:-0}" = "1" ] && exit 0

block() {
  echo "Blocked by .claude/hooks/protect-paths.sh: $1 ($path). For a deliberate exception, the owner exports ORENETA_ALLOW_PROTECTED=1." >&2
  exit 2
}

case "$path" in
  */.env.example) ;;
  .env | .env.* | */.env | */.env.* | */secrets/* | secrets/* | *.pem | *.key | *.p8 | *.keystore | *.jks | */google-services.json | */GoogleService-Info.plist)
    block "secrets are not written from Claude"
    ;;
  */frontend/src/generated/locales.ts | frontend/src/generated/locales.ts | \
    *mobile/android/src/main/res/values/strings.xml | *mobile/android/src/main/res/values-*/strings.xml | \
    *mobile/android/src/main/java/jp/nonbili/meron/GeneratedIcuStrings.kt | \
    *mobile/ios/Meron/Localizable.xcstrings | \
    *mobile/ui/src/commonMain/kotlin/jp/nonbili/meron/ui/GeneratedStrings.kt)
    block "this file is generated: edit locales/*.json and run bun run i18n:generate"
    ;;
esac
exit 0
