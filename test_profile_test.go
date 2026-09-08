package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type testProfile struct {
	Home, Config, Cache string
}

// isolateTestProfile must precede code that writes app directories. t.Setenv
// also prevents accidentally running a process-wide profile fixture in parallel.
func isolateTestProfile(t *testing.T) testProfile {
	t.Helper()
	p := testProfile{Home: t.TempDir()}
	t.Setenv("HOME", p.Home)
	t.Setenv("USERPROFILE", p.Home)
	t.Setenv("APPDATA", filepath.Join(p.Home, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(p.Home, "AppData", "Local"))
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("XDG_DATA_HOME", filepath.Join(p.Home, ".local", "share"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(p.Home, ".local", "state"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(p.Home, "run"))
	t.Setenv("devserver", "")
	t.Setenv("frontenddevserverurl", "")
	switch runtime.GOOS {
	case "windows":
		p.Config = filepath.Join(p.Home, "AppData", "Roaming")
		p.Cache = filepath.Join(p.Home, "AppData", "Local")
	case "darwin":
		p.Config = filepath.Join(p.Home, "Library", "Application Support")
		p.Cache = filepath.Join(p.Home, "Library", "Caches")
	default:
		p.Config = filepath.Join(p.Home, ".config")
		p.Cache = filepath.Join(p.Home, ".cache")
	}
	return p
}

func TestIsolatedProfileUsesOnlyTemporaryDirectories(t *testing.T) {
	p := isolateTestProfile(t)
	for _, tc := range []struct {
		name    string
		resolve func() (string, error)
		want    string
	}{
		{"home", os.UserHomeDir, p.Home},
		{"config", os.UserConfigDir, p.Config},
		{"cache", os.UserCacheDir, p.Cache},
	} {
		got, err := tc.resolve()
		if err != nil || got != tc.want {
			t.Fatalf("%s directory = %q, %v; want %q", tc.name, got, err, tc.want)
		}
	}
	t.Run("child profile cannot contaminate parent", func(t *testing.T) {
		child := isolateTestProfile(t)
		if child.Home == p.Home || child.Config == p.Config || child.Cache == p.Cache {
			t.Fatal("profile directories reused across tests")
		}
	})
	if got := appCacheDir(); got != filepath.Join(p.Cache, "oreneta") {
		t.Fatalf("parent environment was not restored: %q", got)
	}
}
