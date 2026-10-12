package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// isolatedHome points every platform's config and cache directory at a
// temporary one and restores the default profile afterwards.
func isolatedHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	for _, name := range []string{"XDG_CONFIG_HOME", "XDG_CACHE_HOME", "AppData", "LocalAppData", "HOME"} {
		t.Setenv(name, home)
	}
	t.Setenv("devserver", "")
	t.Setenv("frontenddevserverurl", "")
	t.Cleanup(func() { selectProfile(defaultProfileID) })
	return home
}

func TestProfileArgumentsAndEnvironment(t *testing.T) {
	env := func(value string) func(string) string {
		return func(name string) string {
			if name == "MERON_PROFILE" {
				return value
			}
			return ""
		}
	}
	got, rest := profileFromArgs([]string{"mailto:a@x.cat", "--profile=work"}, env(""))
	if got != "work" || len(rest) != 1 || rest[0] != "mailto:a@x.cat" {
		t.Fatalf("got %q %v", got, rest)
	}
	if got, _ := profileFromArgs([]string{"--profile", "home"}, env("work")); got != "home" {
		t.Fatalf("the argument wins over the environment, got %q", got)
	}
	if got, _ := profileFromArgs(nil, env("work")); got != "work" {
		t.Fatalf("got %q", got)
	}
}

func TestProfilesAreCreatedRenamedAndKeptApart(t *testing.T) {
	isolatedHome(t)
	app := &App{}
	defaultDir := appConfigDir()

	created, err := app.profilesCreate(map[string]any{"name": "  Work Mail "})
	if err != nil {
		t.Fatal(err)
	}
	id := created.(map[string]any)["id"].(string)
	if id != "work-mail" {
		t.Fatalf("id %q", id)
	}
	if _, err := app.profilesCreate(map[string]any{"name": "work mail"}); err == nil {
		t.Fatal("a second profile with the same name must be refused")
	}
	second, _ := app.profilesCreate(map[string]any{"name": "Work-Mail!"})
	if second.(map[string]any)["id"] != "work-mail-2" {
		t.Fatalf("ids stay unique, got %v", second)
	}
	if _, err := app.profilesCreate(map[string]any{"name": "   "}); err == nil {
		t.Fatal("an empty name must be refused")
	}

	listed, _ := app.profilesList()
	rows := listed.(map[string]any)["profiles"].([]map[string]any)
	if len(rows) != 3 || rows[0]["id"] != defaultProfileID || rows[0]["active"] != true {
		t.Fatalf("rows %v", rows)
	}

	if _, err := app.profilesRename(map[string]any{"id": id, "name": "Office"}); err != nil {
		t.Fatal(err)
	}
	if windowTitle(id) != "Oreneta — Office" {
		t.Fatalf("title %q", windowTitle(id))
	}

	// Opening the profile moves every path; the default one keeps its own.
	if selectProfile(id) != id {
		t.Fatal("a known profile is selected")
	}
	if appConfigDir() == defaultDir || !strings.HasPrefix(appConfigDir(), filepath.Join(defaultDir, "profiles")) {
		t.Fatalf("config dir %q", appConfigDir())
	}
	if !strings.Contains(mediaDir(), filepath.Join("profiles", id)) {
		t.Fatalf("media dir %q", mediaDir())
	}
	if !strings.HasSuffix(appUniqueID(), ".profile."+id) {
		t.Fatalf("lock %q", appUniqueID())
	}
	env := strings.Join(sidecarEnv(), "\n")
	if !strings.Contains(env, "MERON_PROFILE="+id) || !strings.Contains(env, filepath.Join("profiles", id, "meron.db")) {
		t.Fatal("the core is started on the profile's store and keychain names")
	}
	if !strings.HasPrefix(filepath.Join(rootCacheDir(), "bin"), rootCacheDir()) || strings.Contains(updateCacheDir(), "profiles") {
		t.Fatal("the core binary and updates belong to the installation")
	}

	if selectProfile("nobody") != defaultProfileID || selectProfile("../etc") != defaultProfileID {
		t.Fatal("an unknown or malformed profile opens the default one")
	}
	if appConfigDir() != defaultDir {
		t.Fatalf("back on %q", appConfigDir())
	}
}

// stubPurge replaces the core's keychain purge for a test.
func stubPurge(t *testing.T, fail error) *[]string {
	t.Helper()
	called := []string{}
	previous := purgeProfileSecrets
	purgeProfileSecrets = func(id string) error {
		called = append(called, id)
		return fail
	}
	t.Cleanup(func() { purgeProfileSecrets = previous })
	return &called
}

func usedProfile(t *testing.T, app *App, name string) string {
	t.Helper()
	created, err := app.profilesCreate(map[string]any{"name": name})
	if err != nil {
		t.Fatal(err)
	}
	id := created.(map[string]any)["id"].(string)
	dir := profileDir(rootConfigDir(), id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "meron.db"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return id
}

func listed(id string) bool {
	profiles, _ := readProfiles()
	for _, profile := range profiles {
		if profile.ID == id {
			return true
		}
	}
	return false
}

func TestAnUnusedProfileIsDeletedWithoutTypingItsName(t *testing.T) {
	isolatedHome(t)
	app := &App{}
	purges := stubPurge(t, nil)
	created, _ := app.profilesCreate(map[string]any{"name": "Spare"})
	id := created.(map[string]any)["id"].(string)
	other := usedProfile(t, app, "Used")

	if _, err := app.profilesDelete(map[string]any{"id": defaultProfileID}); err == nil {
		t.Fatal("the default profile stays")
	}
	if _, err := app.profilesDelete(map[string]any{"id": id}); err != nil {
		t.Fatal(err)
	}
	if listed(id) || len(*purges) != 0 {
		t.Fatalf("listed=%v purges=%v", listed(id), *purges)
	}
	if _, err := os.Stat(filepath.Join(profileDir(rootConfigDir(), other), "meron.db")); err != nil {
		t.Fatal("another profile's data is untouched")
	}
}

func TestAProfileWithDataIsDeletedOnlyByNameAfterItsSecretsGo(t *testing.T) {
	isolatedHome(t)
	app := &App{}
	purges := stubPurge(t, nil)
	id := usedProfile(t, app, "Work")
	cache := profileDir(rootCacheDir(), id)
	if err := os.MkdirAll(cache, 0o700); err != nil {
		t.Fatal(err)
	}

	for _, typed := range []string{"", "work", "Wor"} {
		if _, err := app.profilesDelete(map[string]any{"id": id, "confirmName": typed}); err == nil {
			t.Fatalf("deleted with %q typed", typed)
		}
	}
	if !listed(id) || len(*purges) != 0 {
		t.Fatal("nothing happens without the name")
	}
	res, err := app.profilesDelete(map[string]any{"id": id, "confirmName": "Work"})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["secretsRemoved"] != true || len(*purges) != 1 || (*purges)[0] != id {
		t.Fatalf("res=%v purges=%v", res, *purges)
	}
	if listed(id) || fileExists(profileDir(rootConfigDir(), id)) || fileExists(cache) {
		t.Fatal("the profile and its folders are gone")
	}
	if !fileExists(filepath.Join(rootConfigDir(), "profiles.json")) {
		t.Fatal("the profile list stays")
	}
}

func TestAnOpenProfileIsNotDeleted(t *testing.T) {
	isolatedHome(t)
	app := &App{}
	purges := stubPurge(t, nil)
	id := usedProfile(t, app, "Open")
	// Its own process holds its lock.
	release, err := lockProfile(id)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	_, err = app.profilesDelete(map[string]any{"id": id, "confirmName": "Open"})
	if !errors.Is(err, errProfileInUse) {
		t.Fatalf("got %v", err)
	}
	if !listed(id) || len(*purges) != 0 || !fileExists(filepath.Join(profileDir(rootConfigDir(), id), "meron.db")) {
		t.Fatal("an open profile is left whole")
	}
}

func TestAFailedPurgeDeletesNothingUnlessChosen(t *testing.T) {
	isolatedHome(t)
	app := &App{}
	stubPurge(t, errors.New("the store could not be read"))
	id := usedProfile(t, app, "Broken")
	res, err := app.profilesDelete(map[string]any{"id": id, "confirmName": "Broken"})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["purgeFailed"] != "the store could not be read" || !listed(id) {
		t.Fatalf("res=%v", res)
	}
	res, err = app.profilesDelete(map[string]any{"id": id, "confirmName": "Broken", "force": true})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["secretsRemoved"] != false || listed(id) {
		t.Fatalf("res=%v", res)
	}
}

func TestThePurgeRunsInTheProfileBeingDeleted(t *testing.T) {
	isolatedHome(t)
	env := purgeEnv([]string{"HOME=/h", "MERON_PROFILE=default", "MERON_CORE_DB=/wrong.db", "MERON_KEYRING=off"}, "work")
	joined := strings.Join(env, "\n")
	for _, want := range []string{
		"MERON_PROFILE=work",
		"MERON_CORE_DB=" + filepath.Join(rootConfigDir(), "profiles", "work", "meron.db"),
		"MERON_KEYRING=off",
		"HOME=/h",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %s in %v", want, env)
		}
	}
	if strings.Contains(joined, "MERON_PROFILE=default") || strings.Contains(joined, "/wrong.db") {
		t.Fatalf("the running profile leaks into the purge: %v", env)
	}
}

func TestOpeningAProfileStartsItsOwnProcess(t *testing.T) {
	isolatedHome(t)
	app := &App{}
	created, _ := app.profilesCreate(map[string]any{"name": "Home"})
	id := created.(map[string]any)["id"].(string)
	var started []string
	previous := startProfile
	startProfile = func(id string) error { started = append(started, id); return nil }
	t.Cleanup(func() { startProfile = previous })

	if _, err := app.profilesOpen(map[string]any{"id": id}); err != nil {
		t.Fatal(err)
	}
	if res, _ := app.profilesOpen(map[string]any{"id": defaultProfileID}); res.(map[string]any)["already_open"] != true {
		t.Fatal("the open profile is not started twice")
	}
	if _, err := app.profilesOpen(map[string]any{"id": "gone"}); err == nil {
		t.Fatal("an unknown profile is refused")
	}
	if len(started) != 1 || started[0] != id {
		t.Fatalf("started %v", started)
	}
}

func TestADamagedProfileListIsReportedNotReplaced(t *testing.T) {
	isolatedHome(t)
	if err := os.MkdirAll(rootConfigDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(rootConfigDir(), profilesFile)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	if _, err := app.profilesCreate(map[string]any{"name": "New"}); err == nil {
		t.Fatal("expected an error")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "{not json" {
		t.Fatal("the damaged list is left for recovery, not overwritten")
	}
	if selectProfile("new") != defaultProfileID {
		t.Fatal("the default profile still opens")
	}
}

func TestThePageIsToldItsProfile(t *testing.T) {
	isolatedHome(t)
	page := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html><head lang="en"><title>x</title></head></html>`))
	})
	recorder := httptest.NewRecorder()
	profileMiddleware(page).ServeHTTP(recorder, httptest.NewRequest("GET", "/", nil))
	body := recorder.Body.String()
	if !strings.Contains(body, `<head lang="en"><meta name="oreneta-profile" content="default"><title>`) {
		t.Fatalf("body %s", body)
	}
	if recorder.Header().Get("Content-Length") == "" {
		t.Fatal("length set for the new body")
	}
	asset := httptest.NewRecorder()
	profileMiddleware(page).ServeHTTP(asset, httptest.NewRequest("GET", "/assets/app.js", nil))
	if strings.Contains(asset.Body.String(), "oreneta-profile") {
		t.Fatal("only the document is changed")
	}
}

func TestProfileArchiveNamesAndPassphraseGuard(t *testing.T) {
	when := time.Date(2026, 10, 11, 9, 0, 0, 0, time.UTC)
	if got := profileArchiveFilename(when); got != "oreneta-profile-2026-10-11.oreneta-profile" {
		t.Fatalf("got %q", got)
	}
	app := &App{}
	if _, err := app.exportProfileArchive(map[string]any{"passphrase": "short"}); err == nil {
		t.Fatal("a short passphrase is refused before anything else")
	}
}

// The real core's purge mode: it runs inside the named profile and refuses
// the default one. Skipped when the core is not built.
func TestTheCorePurgesOnlyANamedProfile(t *testing.T) {
	core, _ := filepath.Abs(filepath.Join("meron-core", "target", "debug", "meron-core"+sidecarExeSuffix))
	if !fileExists(core) {
		t.Skip("meron-core is not built")
	}
	isolatedHome(t)
	run := func(id string) (string, error) {
		cmd := exec.Command(core, "--purge-profile")
		cmd.Env = append(purgeEnv(os.Environ(), id), "MERON_KEYRING=off")
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	if err := os.MkdirAll(profileDir(rootConfigDir(), "work"), 0o700); err != nil {
		t.Fatal(err)
	}
	out, err := run("work")
	if err != nil || !strings.Contains(out, `"purged"`) {
		t.Fatalf("err=%v out=%s", err, out)
	}
	if out, err := run(defaultProfileID); err == nil {
		t.Fatalf("the default profile was purged: %s", out)
	}
}
