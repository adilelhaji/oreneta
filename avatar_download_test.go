package main

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func pngServer(t *testing.T) *httptest.Server {
	t.Helper()
	pngBytes, err := base64.StdEncoding.DecodeString(tinyPNGBase64)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(pngBytes)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestSaveAvatarKeepsACopyOnThisComputer(t *testing.T) {
	isolateTestProfile(t)
	server := pngServer(t)

	app := directApp()
	localURL, err := app.saveAvatar("test-user@example.com", server.URL)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.HasPrefix(localURL, "/media/avatars/test-user-example-com/") {
		t.Errorf("expected local url to start with /media/avatars/test-user-example-com/, got %q", localURL)
	}
	if !strings.HasSuffix(localURL, ".png") {
		t.Errorf("expected local url to end with .png, got %q", localURL)
	}

	// Verify file exists on disk
	path := filepath.Join(mediaDir(), strings.TrimPrefix(localURL, "/media/"))
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("downloaded avatar file missing: %v", err)
	}
}

func TestSaveAvatarIgnoresNonRemote(t *testing.T) {
	app := directApp()
	for _, value := range []string{"/media/avatars/user/abc.png", ""} {
		got, err := app.saveAvatar("user", value)
		if err != nil || got != value {
			t.Errorf("saveAvatar(%q) = %q, %v; want it untouched", value, got, err)
		}
	}
}

// A failed download never hands the remote address back as the picture: the
// web view would load it directly, without the proxy (#194).
func TestSaveAvatarNeverReturnsTheRemoteAddress(t *testing.T) {
	isolateTestProfile(t)
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusInternalServerError)
	}))
	defer refusing.Close()
	notAnImage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(make([]byte, 5*1024*1024+10))
	}))
	defer notAnImage.Close()

	cases := map[string]struct {
		app *App
		url string
	}{
		"a server error":         {directApp(), refusing.URL},
		"an image that is huge":  {directApp(), notAnImage.URL},
		"an unreachable address": {directApp(), "http://127.0.0.1:1/me.png"},
		"an unusable proxy": {
			&App{proxyLookup: func(string) (*proxySetting, error) { return &proxySetting{Mode: "http"}, nil }},
			"http://avatars.example.test/me.png",
		},
	}
	for name, c := range cases {
		got, err := c.app.saveAvatar("acct", c.url)
		if err == nil || got != "" {
			t.Errorf("%s: got %q, %v; want no picture and an error", name, got, err)
		}
	}
}

func avatarApp(t *testing.T, plans ...sidecarResponsePlan) (*App, *recordingSidecarWriter) {
	t.Helper()
	app, writer := newMailHandlerTestApp(t, plans...)
	app.proxyLookup = func(string) (*proxySetting, error) { return nil, nil }
	return app, writer
}

func avatarPending(rows ...map[string]any) sidecarResponsePlan {
	list := make([]any, 0, len(rows))
	for _, row := range rows {
		list = append(list, row)
	}
	return sidecarResponsePlan{Result: map[string]any{"accounts": list}}
}

func avatarOK() sidecarResponsePlan { return sidecarResponsePlan{Result: map[string]any{"ok": true}} }

// A picture that cannot be fetched is kept only as its source; what the
// account shows is never a remote address.
func TestSettleAvatarsKeepsAFailedPictureOnlyAsItsSource(t *testing.T) {
	isolateTestProfile(t)
	const remote = "http://127.0.0.1:1/me.png"
	app, writer := avatarApp(t,
		avatarPending(
			map[string]any{"id": "waiting", "avatar_url": "", "avatar_source": remote},
			// As earlier versions left it after a failed download.
			map[string]any{"id": "old", "avatar_url": remote, "avatar_source": ""},
		),
		avatarOK(), avatarOK(),
	)

	app.settleAvatars()

	if len(writer.calls) != 3 {
		t.Fatalf("calls = %#v", writer.calls)
	}
	assertCall(t, writer.calls[0], "account.pendingAvatars", map[string]any{})
	assertCall(t, writer.calls[1], "account.setAvatar", map[string]any{"account": "waiting", "avatar_source": remote})
	assertCall(t, writer.calls[2], "account.setAvatar", map[string]any{"account": "old", "avatar_url": "", "avatar_source": remote})
}

// A later retry through the account route stores the local copy and drops the
// source.
func TestSettleAvatarsStoresTheCopyOnceItCanBeFetched(t *testing.T) {
	isolateTestProfile(t)
	var up atomic.Bool
	pngBytes, _ := base64.StdEncoding.DecodeString(tinyPNGBase64)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			http.Error(w, "later", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Write(pngBytes)
	}))
	defer server.Close()
	row := map[string]any{"id": "acct", "avatar_url": "", "avatar_source": server.URL}

	app, writer := avatarApp(t, avatarPending(row), avatarOK(), avatarPending(row), avatarOK())
	app.settleAvatars()
	assertCall(t, writer.calls[1], "account.setAvatar", map[string]any{"account": "acct", "avatar_source": server.URL})

	up.Store(true)
	app.settleAvatars()
	last := writer.calls[3]
	if last.Method != "account.setAvatar" || last.Params["avatar_source"] != "" {
		t.Fatalf("retry call = %#v", last)
	}
	local, _ := last.Params["avatar_url"].(string)
	if !strings.HasPrefix(local, "/media/avatars/acct/") {
		t.Fatalf("avatar_url = %q, want a local copy", local)
	}
	if _, err := os.Stat(filepath.Join(mediaDir(), strings.TrimPrefix(local, "/media/"))); err != nil {
		t.Fatalf("local copy missing: %v", err)
	}
}

// Choosing a remote picture that cannot be fetched now leaves the previous
// picture as it is and waits for a retry, without raising an error.
func TestAccountSetAvatarKeepsThePreviousPictureWhenTheDownloadFails(t *testing.T) {
	isolateTestProfile(t)
	const remote = "http://127.0.0.1:1/me.png"
	app, writer := avatarApp(t, avatarOK())

	res, err := app.accountSetAvatar(map[string]any{"id": "acct", "avatar_url": remote})
	if err != nil {
		t.Fatal(err)
	}
	if got := res.(map[string]any); got["ok"] != true || got["pending"] != true {
		t.Fatalf("result = %#v, want ok and pending", got)
	}
	if len(writer.calls) != 1 {
		t.Fatalf("calls = %#v", writer.calls)
	}
	assertCall(t, writer.calls[0], "account.setAvatar", map[string]any{"account": "acct", "avatar_source": remote})
}

func TestAccountSetAvatarStoresACopyAndClearsTheSource(t *testing.T) {
	isolateTestProfile(t)
	server := pngServer(t)
	app, writer := avatarApp(t, avatarOK(), avatarOK(), avatarOK())

	res, err := app.accountSetAvatar(map[string]any{"id": "acct", "avatar_url": server.URL})
	if err != nil || res.(map[string]any)["pending"] != false {
		t.Fatalf("result = %#v, %v", res, err)
	}
	local, _ := writer.calls[0].Params["avatar_url"].(string)
	if !strings.HasPrefix(local, "/media/avatars/acct/") || writer.calls[0].Params["avatar_source"] != "" {
		t.Fatalf("call = %#v", writer.calls[0])
	}

	// A picture that is already local, or none at all, also clears the source.
	app.accountSetAvatar(map[string]any{"id": "acct", "avatar_url": "/media/avatars/acct/mine.png"})
	assertCall(t, writer.calls[1], "account.setAvatar",
		map[string]any{"account": "acct", "avatar_url": "/media/avatars/acct/mine.png", "avatar_source": ""})
	app.accountSetAvatar(map[string]any{"id": "acct", "avatar_url": ""})
	assertCall(t, writer.calls[2], "account.setAvatar",
		map[string]any{"account": "acct", "avatar_url": "", "avatar_source": ""})
}

// Whatever an earlier version stored, the interface is never handed an
// address it would load directly.
func TestAccountListNeverHandsOutARemotePicture(t *testing.T) {
	app, _ := newMailHandlerTestApp(t, sidecarResponsePlan{Result: map[string]any{
		"accounts": []any{
			map[string]any{"id": "remote", "email": "a@example.com", "avatar_url": "https://img.example/a.png"},
			map[string]any{"id": "plain", "email": "b@example.com", "avatar_url": "http://img.example/b.png"},
			map[string]any{"id": "local", "email": "c@example.com", "avatar_url": "/media/avatars/local/c.png"},
		},
	}})

	res, err := app.accountList()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, acc := range res.(map[string]any)["accounts"].([]Account) {
		got[acc.ID] = acc.AvatarURL
	}
	want := map[string]string{"remote": "", "plain": "", "local": "/media/avatars/local/c.png"}
	for id, avatar := range want {
		if got[id] != avatar {
			t.Errorf("%s: avatar = %q, want %q", id, got[id], avatar)
		}
	}
}
