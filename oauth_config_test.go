package main

import (
	"strings"
	"testing"

	"meron/internal/obf"
)

// A value of the wrong shape is no configuration at all: sign-in is offered
// only for a client ID the provider could accept, and the same answer goes to
// the sidecar, so the refresh path cannot use what sign-in refused.
func TestOAuthRejectsMalformedClientValues(t *testing.T) {
	for _, id := range []string{
		"google-id",
		"1234-own.apps.googleusercontent.com.evil.example",
		" 1234-own.apps.googleusercontent.com",
		"1234-own.apps.googleusercontent.com\n",
	} {
		t.Setenv("MERON_GOOGLE_CLIENT_ID", id)
		t.Setenv("MERON_GOOGLE_CLIENT_SECRET", "google-secret")
		if got := googleClientID(); got != "" {
			t.Fatalf("googleClientID(%q) = %q, want empty", id, got)
		}
		if gmailOAuthConfigured() {
			t.Fatalf("gmailOAuthConfigured with malformed id %q", id)
		}
		if _, err := (&App{}).gmailBegin(); err == nil {
			t.Fatalf("gmailBegin accepted malformed id %q", id)
		}
	}

	t.Setenv("MERON_GOOGLE_CLIENT_ID", "1234-own.apps.googleusercontent.com")
	t.Setenv("MERON_GOOGLE_CLIENT_SECRET", "secret with spaces")
	if gmailOAuthConfigured() {
		t.Fatal("gmailOAuthConfigured with a malformed secret")
	}
	for _, entry := range sidecarEnv() {
		if strings.HasPrefix(entry, "MERON_GOOGLE_CLIENT_SECRET=") {
			t.Fatalf("sidecar received a malformed secret: %q", entry)
		}
	}

	old := outlookClientIDObf
	t.Cleanup(func() { outlookClientIDObf = old })
	for _, id := range []string{"outlook-id", "00000000-0000-0000-0000-00000000000", "{00000000-0000-0000-0000-000000000001}"} {
		outlookClientIDObf = obf.Encode(id)
		if outlookOAuthConfigured() {
			t.Fatalf("outlookOAuthConfigured with malformed id %q", id)
		}
		if _, err := (&App{}).outlookBegin(); err == nil {
			t.Fatalf("outlookBegin accepted malformed id %q", id)
		}
	}
	outlookClientIDObf = obf.Encode("00000000-0000-0000-0000-000000000001")
	if !outlookOAuthConfigured() {
		t.Fatal("outlookOAuthConfigured = false with a well-formed id")
	}
}

// Google's consent screen lets a person untick a permission, and a token
// without the calendar one is refused by the Calendar API (#244). What the
// token answer says is logged as it is; an answer that lists nothing is not
// read as a refusal.
func TestCalendarScopeGrantedReadsTheTokenAnswer(t *testing.T) {
	if !strings.Contains(" "+googleScopes+" ", " "+googleCalendarScope+" ") {
		t.Fatalf("sign-in must ask for the calendar scope: %q", googleScopes)
	}
	for granted, want := range map[string]string{
		"https://mail.google.com/ " + googleCalendarScope + " openid": "yes",
		googleCalendarScope: "yes",
		"https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email": "no",
		// Read-only calendar access is not what the client asked for or uses.
		"https://www.googleapis.com/auth/calendar.readonly": "no",
		"":    "unknown",
		"   ": "unknown",
	} {
		if got := calendarScopeGranted(granted); got != want {
			t.Errorf("calendarScopeGranted(%q) = %q, want %q", granted, got, want)
		}
	}
}
