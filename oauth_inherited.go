//go:build !distributable

package main

// Internal development builds only. These are Meron's registrations, verified
// by and belonging to someone else; they let a developer sign in without a
// client of their own. A distributable build (-tags distributable) leaves this
// file out and never falls back to them: see oauth_distributable.go and
// docs/oauth-registrations.md.
//
// Obfuscated Google OAuth credentials, with the Outlook public-client ID.
// Per Google's installed-app model the client secret is not confidential; the
// obfuscation (see internal/obf) only defeats plaintext scraping, not a
// determined extractor. Generate replacements with:  go run ./cmd/obfuscate
var (
	googleClientIDObf     = "f1FFXVgbXFZAQFgZWwGpVyUNGAkfQAFVQRgJGE4G6At0ABwFDF8NFx0EBl1HH/tMPRZcCAFCCA0QARtIBFL1UjkAHBtATgAM"
	googleClientSecretObf = "CioxPD51QlcQNz0fIkvUSwoRQC4vaQM2QC4ydTtzw1Y0DQA="

	// Outlook is a public client (PKCE), so there is no client secret — only the
	// Application (client) ID.
	outlookClientIDObf = "egQUWl8cWVZYQg1JFxyuWntTX1dbHFtMEEFZG0VUrgx7XBcN"
)

// inheritedOAuth reports that this build carries registrations Oreneta does
// not own.
const inheritedOAuth = true
