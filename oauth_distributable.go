//go:build distributable

package main

// A distributable build carries no inherited registration. Oreneta-owned
// values, obfuscated with `go run ./cmd/obfuscate`, are injected at build time:
//
//	-ldflags "-X main.googleClientIDObf=… -X main.googleClientSecretObf=… -X main.outlookClientIDObf=…"
//
// Without them (or with a malformed one) the matching sign-in is unavailable:
// the wizard says so and offers manual IMAP/SMTP, EWS and calendar
// subscriptions instead, and an account already signed in is asked to
// reconnect when its token needs refreshing.
var (
	googleClientIDObf     = ""
	googleClientSecretObf = ""
	outlookClientIDObf    = ""
)

// inheritedOAuth reports that this build carries registrations Oreneta does
// not own.
const inheritedOAuth = false
