//go:build distributable

package main

import (
	"strings"
	"testing"

	"meron/internal/obf"
)

// A distributable build has no inherited registration to fall back to: with
// nothing injected, every OAuth sign-in is unavailable and nothing reaches
// the sidecar, while accounts that do not use OAuth are unaffected.
func TestDistributableBuildFailsClosedWithoutOwnedOAuth(t *testing.T) {
	t.Setenv("MERON_GOOGLE_CLIENT_ID", "")
	t.Setenv("MERON_GOOGLE_CLIENT_SECRET", "")
	t.Setenv("MERON_OUTLOOK_CLIENT_ID", "")

	if inheritedOAuth {
		t.Fatal("distributable build reports inherited registrations")
	}
	if googleClientIDObf != "" || googleClientSecretObf != "" || outlookClientIDObf != "" {
		t.Fatal("distributable build compiled OAuth values without an explicit injection")
	}
	if gmailOAuthConfigured() || outlookOAuthConfigured() {
		t.Fatal("OAuth reported configured with nothing owned")
	}
	app := &App{}
	if _, err := app.gmailBegin(); err == nil {
		t.Fatal("gmailBegin started without an owned Google client")
	}
	if _, err := app.outlookBegin(); err == nil {
		t.Fatal("outlookBegin started without an owned Microsoft client")
	}
	if _, err := app.accountAddGmailOAuth(map[string]any{"auth_code": "code"}); err == nil {
		t.Fatal("accountAddGmailOAuth exchanged a code without an owned Google client")
	}
	for _, entry := range sidecarEnv() {
		if strings.HasPrefix(entry, "MERON_GOOGLE_") || strings.HasPrefix(entry, "MERON_OUTLOOK_") {
			t.Fatalf("sidecar received OAuth configuration: %q", strings.SplitN(entry, "=", 2)[0])
		}
	}
	// Microsoft Graph signs in with the same Microsoft client and is refused
	// with it, before any browser opens.
	if _, err := app.invoke("oauth.graphBegin", map[string]any{"account": "graph@example.test"}); err == nil || !strings.Contains(err.Error(), "client ID missing") {
		t.Fatal("graph sign-in started without an owned Microsoft client")
	}
}

// Owned values injected at build time are used, and only those.
func TestDistributableBuildUsesInjectedOwnedOAuth(t *testing.T) {
	t.Setenv("MERON_GOOGLE_CLIENT_ID", "")
	t.Setenv("MERON_GOOGLE_CLIENT_SECRET", "")
	saved := [3]string{googleClientIDObf, googleClientSecretObf, outlookClientIDObf}
	t.Cleanup(func() {
		googleClientIDObf, googleClientSecretObf, outlookClientIDObf = saved[0], saved[1], saved[2]
	})
	googleClientIDObf = obf.Encode("1234-owned.apps.googleusercontent.com")
	googleClientSecretObf = obf.Encode("owned-secret")
	outlookClientIDObf = obf.Encode("00000000-0000-0000-0000-0000000000aa")

	if got := googleClientID(); got != "1234-owned.apps.googleusercontent.com" {
		t.Fatalf("googleClientID = %q", got)
	}
	if !gmailOAuthConfigured() || !outlookOAuthConfigured() {
		t.Fatal("injected owned values not reported as configured")
	}
	env := strings.Join(sidecarEnv(), "\n")
	if !strings.Contains(env, "MERON_OUTLOOK_CLIENT_ID=00000000-0000-0000-0000-0000000000aa") {
		t.Fatal("sidecar did not receive the owned Microsoft client")
	}
}
