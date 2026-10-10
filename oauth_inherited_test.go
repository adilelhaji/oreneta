//go:build !distributable

package main

import (
	"strings"
	"testing"
)

// Google's credentials come from the environment when one is set, because
// Oreneta must not sign in with Meron's: those were verified by, and belong
// to, someone else. A build with none of its own falls back to what is baked
// in, so nothing is broken for a developer who has not registered a client.
//
// Outlook's is the opposite and stays baked-in only — there is no equivalent
// reason to let the environment choose who the app claims to be.
func TestGoogleOAuthTakesCredentialsFromEnvironment(t *testing.T) {
	t.Setenv("MERON_GOOGLE_CLIENT_ID", "1234-own.apps.googleusercontent.com")
	t.Setenv("MERON_GOOGLE_CLIENT_SECRET", "google-secret")
	t.Setenv("MERON_OUTLOOK_CLIENT_ID", "00000000-0000-0000-0000-000000000001")

	if got, want := googleClientID(), "1234-own.apps.googleusercontent.com"; got != want {
		t.Fatalf("googleClientID = %q, want %q", got, want)
	}
	if got, want := googleClientSecret(), "google-secret"; got != want {
		t.Fatalf("googleClientSecret = %q, want %q", got, want)
	}
	if !gmailOAuthConfigured() {
		t.Fatal("gmailOAuthConfigured = false with credentials from the environment")
	}
	if got := outlookClientID(); got == "" || got == "00000000-0000-0000-0000-000000000001" {
		t.Fatalf("outlookClientID = %q, want baked id", got)
	}
	if !outlookOAuthConfigured() {
		t.Fatal("outlookOAuthConfigured = false with baked client id")
	}
}

// With nothing in the environment the baked-in credentials still answer, so a
// build that ships its own keeps working.
func TestGoogleOAuthFallsBackToBakedCredentials(t *testing.T) {
	t.Setenv("MERON_GOOGLE_CLIENT_ID", "")
	t.Setenv("MERON_GOOGLE_CLIENT_SECRET", "")

	if got := googleClientID(); got == "" || got == "1234-own.apps.googleusercontent.com" {
		t.Fatalf("googleClientID = %q, want baked id", got)
	}
	if got := googleClientSecret(); got == "" || got == "google-secret" {
		t.Fatalf("googleClientSecret = %q, want baked secret", got)
	}
	if !gmailOAuthConfigured() {
		t.Fatal("gmailOAuthConfigured = false with baked credentials")
	}
}

func TestOutlookOAuthConfiguredFalseWithoutClientID(t *testing.T) {
	t.Setenv("MERON_OUTLOOK_CLIENT_ID", "")

	old := outlookClientIDObf
	outlookClientIDObf = ""
	t.Cleanup(func() {
		outlookClientIDObf = old
	})

	if got := outlookClientID(); got != "" {
		t.Fatalf("outlookClientID = %q, want empty", got)
	}
	if outlookOAuthConfigured() {
		t.Fatal("outlookOAuthConfigured = true, want false")
	}
}

func TestOutlookOAuthConfiguredFromBakedClientID(t *testing.T) {
	t.Setenv("MERON_OUTLOOK_CLIENT_ID", "")

	old := outlookClientIDObf
	t.Cleanup(func() {
		outlookClientIDObf = old
	})

	if got := outlookClientID(); got == "" {
		t.Fatal("outlookClientID = empty with baked client id")
	}
	if !outlookOAuthConfigured() {
		t.Fatal("outlookOAuthConfigured = false with baked client id")
	}
}

// The sidecar refreshes with the client sign-in used, not with whatever the
// process environment holds: Outlook's comes from the build alone.
func TestSidecarEnvCarriesOnlyTheAcceptedOAuthClients(t *testing.T) {
	t.Setenv("MERON_GOOGLE_CLIENT_ID", "")
	t.Setenv("MERON_GOOGLE_CLIENT_SECRET", "")
	t.Setenv("MERON_OUTLOOK_CLIENT_ID", "00000000-0000-0000-0000-0000000000ff")

	var outlook []string
	for _, entry := range sidecarEnv() {
		if name, value, _ := strings.Cut(entry, "="); name == "MERON_OUTLOOK_CLIENT_ID" {
			outlook = append(outlook, value)
		}
	}
	if len(outlook) != 1 || outlook[0] != outlookClientID() {
		t.Fatalf("sidecar Outlook client = %q, want only the build's %q", outlook, outlookClientID())
	}
}
