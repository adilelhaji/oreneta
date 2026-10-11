package main

// Profiles (#99, ADR-0016): separate sets of accounts, mail, contacts,
// notes and preferences on one computer. Each profile has its own store,
// cache and keychain entries, and runs in its own process and window, so
// nothing a profile holds in memory — open drafts, searches, notifications —
// can reach another one. The install every user already has is the
// "default" profile and keeps its paths.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultProfileID = "default"
const profilesFile = "profiles.json"

type profileEntry struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
}

var (
	profileIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)
	profileMu        sync.Mutex
	currentProfile   = defaultProfileID
)

func activeProfile() string {
	profileMu.Lock()
	defer profileMu.Unlock()
	return currentProfile
}

func profileDir(root, id string) string {
	if id == "" || id == defaultProfileID {
		return root
	}
	return filepath.Join(root, "profiles", id)
}

// profileFromArgs reads `--profile=<id>` or `--profile <id>`, falling back to
// MERON_PROFILE. It returns the remaining arguments untouched otherwise.
func profileFromArgs(args []string, getenv func(string) string) (string, []string) {
	chosen := strings.TrimSpace(getenv("MERON_PROFILE"))
	rest := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case strings.HasPrefix(arg, "--profile="):
			chosen = strings.TrimPrefix(arg, "--profile=")
		case arg == "--profile" && i+1 < len(args):
			chosen = args[i+1]
			i++
		default:
			rest = append(rest, arg)
		}
	}
	return chosen, rest
}

// selectProfile makes `id` the active profile when it is a known one. An
// unknown or malformed id opens the default profile rather than creating an
// empty one by accident.
func selectProfile(id string) string {
	id = strings.TrimSpace(id)
	chosen := defaultProfileID
	if id != "" && id != defaultProfileID && profileIDPattern.MatchString(id) {
		if profiles, err := readProfiles(); err == nil {
			for _, profile := range profiles {
				if profile.ID == id {
					chosen = id
				}
			}
		}
	}
	profileMu.Lock()
	currentProfile = chosen
	profileMu.Unlock()
	return chosen
}

func readProfiles() ([]profileEntry, error) {
	data, err := os.ReadFile(filepath.Join(rootConfigDir(), profilesFile))
	if errors.Is(err, os.ErrNotExist) {
		return []profileEntry{{ID: defaultProfileID}}, nil
	}
	if err != nil {
		return nil, err
	}
	var profiles []profileEntry
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, fmt.Errorf("the profile list is damaged: %w", err)
	}
	for _, profile := range profiles {
		if profile.ID == defaultProfileID {
			return profiles, nil
		}
	}
	return append([]profileEntry{{ID: defaultProfileID}}, profiles...), nil
}

// writeProfiles replaces the list atomically: a crash mid-write leaves the
// previous list, never a truncated one.
func writeProfiles(profiles []profileEntry) error {
	dir := rootConfigDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(profiles, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, profilesFile+".tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, profilesFile))
}

func cleanProfileName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("a profile needs a name")
	}
	if len([]rune(name)) > 60 {
		return "", errors.New("a profile name is at most 60 characters")
	}
	return name, nil
}

// newProfileID derives a readable, unique id from the name.
func newProfileID(name string, taken []profileEntry) string {
	base := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		default:
			return '-'
		}
	}, name)
	base = strings.Trim(regexp.MustCompile(`-+`).ReplaceAllString(base, "-"), "-")
	if len(base) > 30 {
		base = strings.Trim(base[:30], "-")
	}
	if base == "" || base == defaultProfileID {
		base = "profile"
	}
	used := map[string]bool{}
	for _, profile := range taken {
		used[profile.ID] = true
	}
	id := base
	for n := 2; used[id]; n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	return id
}

// profileHasData reports whether a profile was ever opened: it has a store.
func profileHasData(id string) bool {
	_, err := os.Stat(filepath.Join(profileDir(rootConfigDir(), id), "meron.db"))
	return err == nil
}

func (a *App) profilesList() (any, error) {
	profiles, err := readProfiles()
	if err != nil {
		return nil, err
	}
	rows := make([]map[string]any, 0, len(profiles))
	for _, profile := range profiles {
		rows = append(rows, map[string]any{
			"id":         profile.ID,
			"name":       profile.Name,
			"created_at": profile.CreatedAt,
			"active":     profile.ID == activeProfile(),
			"has_data":   profileHasData(profile.ID),
		})
	}
	return map[string]any{"profiles": rows, "active": activeProfile()}, nil
}

func (a *App) profilesCreate(payload map[string]any) (any, error) {
	raw, _ := payload["name"].(string)
	name, err := cleanProfileName(raw)
	if err != nil {
		return nil, err
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	profiles, err := readProfiles()
	if err != nil {
		return nil, err
	}
	for _, profile := range profiles {
		if strings.EqualFold(profile.Name, name) {
			return nil, errors.New("there is already a profile with that name")
		}
	}
	entry := profileEntry{ID: newProfileID(name, profiles), Name: name, CreatedAt: time.Now().Unix()}
	if err := writeProfiles(append(profiles, entry)); err != nil {
		return nil, err
	}
	return map[string]any{"id": entry.ID}, nil
}

func (a *App) profilesRename(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	raw, _ := payload["name"].(string)
	name, err := cleanProfileName(raw)
	if err != nil {
		return nil, err
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	profiles, err := readProfiles()
	if err != nil {
		return nil, err
	}
	found := false
	for i := range profiles {
		if profiles[i].ID != id && strings.EqualFold(profiles[i].Name, name) {
			return nil, errors.New("there is already a profile with that name")
		}
		if profiles[i].ID == id {
			profiles[i].Name = name
			found = true
		}
	}
	if !found {
		return nil, errors.New("that profile no longer exists")
	}
	return map[string]any{"ok": true}, writeProfiles(profiles)
}

// profilesDelete removes a profile that was never opened. A profile with
// mail in it is not deleted from here: its keychain entries can only be
// found from inside it (ADR-0016).
func (a *App) profilesDelete(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == defaultProfileID || id == activeProfile() {
		return nil, errors.New("the open profile and the default profile cannot be deleted")
	}
	if profileHasData(id) {
		return nil, errors.New("this profile holds data; open it and remove its accounts first")
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	profiles, err := readProfiles()
	if err != nil {
		return nil, err
	}
	kept := profiles[:0]
	found := false
	for _, profile := range profiles {
		if profile.ID == id {
			found = true
			continue
		}
		kept = append(kept, profile)
	}
	if !found {
		return nil, errors.New("that profile no longer exists")
	}
	if err := writeProfiles(kept); err != nil {
		return nil, err
	}
	_ = os.RemoveAll(profileDir(rootConfigDir(), id))
	_ = os.RemoveAll(profileDir(rootCacheDir(), id))
	return map[string]any{"ok": true}, nil
}

// startProfile launches the app for another profile. It runs as its own
// process with its own single-instance lock; if it is already open, that
// window is brought forward instead.
var startProfile = func(id string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--profile="+id)
	cmd.Env = os.Environ()
	return cmd.Start()
}

func (a *App) profilesOpen(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == activeProfile() {
		return map[string]any{"ok": true, "already_open": true}, nil
	}
	profiles, err := readProfiles()
	if err != nil {
		return nil, err
	}
	for _, profile := range profiles {
		if profile.ID == id {
			return map[string]any{"ok": true}, startProfile(id)
		}
	}
	return nil, errors.New("that profile no longer exists")
}

func windowTitle(profile string) string {
	if profile == defaultProfileID {
		return "Oreneta"
	}
	if profiles, err := readProfiles(); err == nil {
		for _, entry := range profiles {
			if entry.ID == profile && entry.Name != "" {
				return "Oreneta — " + entry.Name
			}
		}
	}
	return "Oreneta — " + profile
}

// profileMiddleware tells the page which profile it belongs to, before any
// script runs: a <meta> tag in the HTML document. The webview's storage is
// shared by every profile, so the page keys what it keeps there by profile.
func profileMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && r.URL.Path != "/index.html" {
			next.ServeHTTP(w, r)
			return
		}
		recorder := httptest.NewRecorder()
		next.ServeHTTP(recorder, r)
		body := recorder.Body.Bytes()
		if strings.HasPrefix(recorder.Header().Get("Content-Type"), "text/html") || bytes.Contains(body, []byte("<head")) {
			body = injectProfileMeta(body, activeProfile())
		}
		for key, values := range recorder.Header() {
			if key == "Content-Length" {
				continue
			}
			w.Header()[key] = values
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(body)
	})
}

func injectProfileMeta(html []byte, profile string) []byte {
	head := bytes.Index(html, []byte("<head"))
	if head < 0 {
		return html
	}
	end := bytes.IndexByte(html[head:], '>')
	if end < 0 {
		return html
	}
	at := head + end + 1
	meta := []byte(`<meta name="oreneta-profile" content="` + profile + `">`)
	out := make([]byte, 0, len(html)+len(meta))
	out = append(out, html[:at]...)
	out = append(out, meta...)
	return append(out, html[at:]...)
}
