package main

import "testing"

// Adding a Google account whose picture cannot be fetched adds the account
// without one: the remote address reaches neither the core as the picture nor
// the interface, and waits for a retry (#194).
func TestAddGmailOAuthKeepsAFailedPictureOnlyAsItsSource(t *testing.T) {
	isolateTestProfile(t)
	t.Setenv("MERON_GOOGLE_CLIENT_ID", "1234567890-abcdef.apps.googleusercontent.com")
	t.Setenv("MERON_GOOGLE_CLIENT_SECRET", "test-secret")
	remote := closedServerURL(t) + "/me.png"
	app, writer := avatarApp(t, avatarOK(), avatarOK(), avatarOK())

	res, err := app.accountAddGmailOAuth(map[string]any{
		"email":         "Ana@Example.com",
		"avatar_url":    remote,
		"access_token":  "access",
		"refresh_token": "refresh",
		"expires_in":    3600,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(writer.calls) != 3 {
		t.Fatalf("calls = %#v", writer.calls)
	}
	if got, ok := writer.calls[0].Params["avatar_url"].(string); writer.calls[0].Method != "account.connect" || !ok || got != "" {
		t.Fatalf("account.connect avatar_url = %#v, want an empty picture", writer.calls[0].Params["avatar_url"])
	}
	assertCall(t, writer.calls[1], "account.setAvatar", map[string]any{"account": "ana@example.com", "avatar_source": remote})
	if got := res.(map[string]any)["account"].(Account).AvatarURL; got != "" {
		t.Fatalf("the interface was given the picture %q", got)
	}
}
