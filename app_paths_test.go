package main

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAppDirsUseProductionProfileByDefault(t *testing.T) {
	p := isolateTestProfile(t)
	wantConfig, wantCache := filepath.Join(p.Config, "oreneta"), filepath.Join(p.Cache, "oreneta")

	if got, want := appDirName(), "oreneta"; got != want {
		t.Fatalf("appDirName() = %q, want %q", got, want)
	}
	if got, want := appUniqueID(), "io.github.adilelhaji.oreneta"; got != want {
		t.Fatalf("appUniqueID() = %q, want %q", got, want)
	}
	if got, want := appConfigDir(), wantConfig; got != want {
		t.Fatalf("appConfigDir() = %q, want %q", got, want)
	}
	if got, want := appCacheDir(), wantCache; got != want {
		t.Fatalf("appCacheDir() = %q, want %q", got, want)
	}
}

func TestAppDirsUseDevProfileForWailsDev(t *testing.T) {
	p := isolateTestProfile(t)
	t.Setenv("devserver", "127.0.0.1:34115")
	t.Setenv("frontenddevserverurl", "")

	wantConfig, wantCache := filepath.Join(p.Config, "oreneta-dev"), filepath.Join(p.Cache, "oreneta-dev")

	if got, want := appDirName(), "oreneta-dev"; got != want {
		t.Fatalf("appDirName() = %q, want %q", got, want)
	}
	if got, want := appUniqueID(), "io.github.adilelhaji.oreneta-dev"; got != want {
		t.Fatalf("appUniqueID() = %q, want %q", got, want)
	}
	if got, want := appConfigDir(), wantConfig; got != want {
		t.Fatalf("appConfigDir() = %q, want %q", got, want)
	}
	if got, want := appCacheDir(), wantCache; got != want {
		t.Fatalf("appCacheDir() = %q, want %q", got, want)
	}
}

func TestAppDirsRespectXDGBaseDirs(t *testing.T) {
	p := isolateTestProfile(t)
	configHome := t.TempDir()
	cacheHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_CACHE_HOME", cacheHome)
	t.Setenv("devserver", "")
	t.Setenv("frontenddevserverurl", "http://127.0.0.1:5178")
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		// These OS APIs intentionally ignore XDG, even if inherited from a shell.
		configHome, cacheHome = p.Config, p.Cache
	}

	configHomeReal, err := filepath.EvalSymlinks(configHome)
	if err != nil {
		configHomeReal = configHome
	}
	cacheHomeReal, err := filepath.EvalSymlinks(cacheHome)
	if err != nil {
		cacheHomeReal = cacheHome
	}

	gotConfig := appConfigDir()
	gotConfigReal, err := filepath.EvalSymlinks(gotConfig)
	if err != nil {
		gotConfigReal = gotConfig
	}

	gotCache := appCacheDir()
	gotCacheReal, err := filepath.EvalSymlinks(gotCache)
	if err != nil {
		gotCacheReal = gotCache
	}

	if got, want := gotConfigReal, filepath.Join(configHomeReal, "oreneta-dev"); got != want {
		t.Fatalf("appConfigDir() = %q, want %q", got, want)
	}
	if got, want := gotCacheReal, filepath.Join(cacheHomeReal, "oreneta-dev"); got != want {
		t.Fatalf("appCacheDir() = %q, want %q", got, want)
	}
}

func TestSidecarEnvUsesProfileDirs(t *testing.T) {
	p := isolateTestProfile(t)
	t.Setenv("devserver", "127.0.0.1:34115")
	t.Setenv("frontenddevserverurl", "")

	wantConfig, wantCache := filepath.Join(p.Config, "oreneta-dev"), filepath.Join(p.Cache, "oreneta-dev")

	env := sidecarEnv()
	assertEnvContains(t, env, "MERON_CORE_DB="+filepath.Join(wantConfig, "meron.db"))
	assertEnvContains(t, env, "MERON_MEDIA_DIR="+filepath.Join(wantCache, "attachments"))
}

func assertEnvContains(t *testing.T, env []string, want string) {
	t.Helper()
	var matches []string
	for _, entry := range env {
		if entry == want {
			return
		}
		if strings.HasPrefix(entry, strings.SplitN(want, "=", 2)[0]+"=") {
			matches = append(matches, entry)
		}
	}
	t.Fatalf("env missing %q; matching keys: %v", want, matches)
}
