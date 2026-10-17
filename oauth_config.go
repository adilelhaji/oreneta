package main

import (
	"os"
	"regexp"
	"strings"

	"meron/internal/obf"
)

const (
	// Loopback host for the OAuth redirect. Per RFC 8252 (OAuth for Native Apps)
	// we bind an ephemeral port (host:0) at flow start and build the redirect URI
	// from the OS-assigned port — both Google and Microsoft match loopback
	// redirects on host only, so the portless URI is what's registered. This
	// avoids hardcoding a port that may already be in use.
	oauthLoopbackHost = "127.0.0.1"

	// Delegated scopes for Outlook/Microsoft 365 IMAP+SMTP access. offline_access
	// yields a refresh token; openid/email/profile populate the id_token we read
	// the account email and name from.
	outlookScopes = "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile"

	outlookTokenURL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"

	// Delegated scopes for Google. Mail over IMAP/SMTP, the profile the account
	// name and address are read from, and the calendar — mail and calendar are
	// set up together, so they are consented to together. A token issued
	// without the calendar scope cannot call the Calendar API, so an account
	// added before this scope existed has to be reconnected once.
	googleScopes = "https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile " + googleCalendarScope + " https://www.googleapis.com/auth/contacts.readonly"

	// The Google permission the Calendar API needs.
	googleCalendarScope = "https://www.googleapis.com/auth/calendar"
)

// calendarScopeGranted says whether a Google token answer granted the
// calendar permission: "yes", "no", or "unknown" when the answer lists no
// scopes at all, which is not taken to mean none were granted. Logged when a
// Gmail account is added (#244): a token without this permission is refused
// by the Calendar API, and the log is where a field failure is diagnosed.
func calendarScopeGranted(granted string) string {
	scopes := strings.Fields(granted)
	if len(scopes) == 0 {
		return "unknown"
	}
	for _, scope := range scopes {
		if scope == googleCalendarScope {
			return "yes"
		}
	}
	return "no"
}

// The environment wins over the compiled credentials, so a build can be run
// against a different Google Cloud project — one with other APIs enabled, or
// a developer's own — without editing tracked source and risking a commit of
// somebody's credentials. The core already reads these same two variables
// when it refreshes a token (see `engine.rs`), so setting them covers the
// whole flow; a release Flatpak sets neither and uses the compiled values.
//
// Which compiled credentials exist depends on the build: an internal
// development build carries the inherited Meron registrations
// (oauth_inherited.go), a distributable build carries only what its build
// injects (oauth_distributable.go). A value of the wrong shape counts as
// absent, so a typo or a truncated injection disables sign-in rather than
// sending people to a provider error page.
func googleClientID() string {
	value := os.Getenv("MERON_GOOGLE_CLIENT_ID")
	if value == "" {
		value = obf.Decode(googleClientIDObf)
	}
	if !validGoogleClientID(value) {
		return ""
	}
	return value
}

func googleClientSecret() string {
	value := os.Getenv("MERON_GOOGLE_CLIENT_SECRET")
	if value == "" {
		value = obf.Decode(googleClientSecretObf)
	}
	if !validClientSecret(value) {
		return ""
	}
	return value
}

// An installed-app client ID from Google Cloud: "<number>-<id>.apps.googleusercontent.com".
var googleClientIDPattern = regexp.MustCompile(`^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$`)

// A Microsoft application (client) ID is a GUID.
var outlookClientIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validGoogleClientID(value string) bool {
	return googleClientIDPattern.MatchString(value)
}

func validClientSecret(value string) bool {
	return value != "" && len(value) <= 256 && !strings.ContainsAny(value, " \t\r\n")
}

func validOutlookClientID(value string) bool {
	return outlookClientIDPattern.MatchString(value)
}

func gmailOAuthConfigured() bool {
	return googleClientID() != "" && googleClientSecret() != ""
}

func outlookClientID() string {
	value := obf.Decode(outlookClientIDObf)
	if !validOutlookClientID(value) {
		return ""
	}
	return value
}

func outlookOAuthConfigured() bool {
	return outlookClientID() != ""
}
