package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// applyUpdate installs the downloaded payload and queues a relaunch. The caller
// quits immediately afterwards.
func applyUpdate(channel updateChannel, payload string) error {
	switch channel.Kind {
	case channelNSIS:
		return runSilentInstaller(payload, channel.Target)
	case channelPortable:
		return replacePortableExe(payload, channel.Target)
	default:
		return fmt.Errorf("update: unsupported channel %q", channel.Kind)
	}
}

// runSilentInstaller launches the NSIS installer in silent mode and starts the
// app again once it finishes. The installer may raise a UAC prompt for a
// per-machine install; the UI warns about that before this is called.
func runSilentInstaller(installer, exe string) error {
	// One detached cmd does both halves so the relaunch survives our exit:
	// /wait blocks until the installer is done, then start re-opens the app.
	script := fmt.Sprintf(`start "" /wait "%s" /S && start "" "%s"`, installer, exe)
	cmd := exec.Command("cmd", "/c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: detachedProcess | createNewProcessGroup}
	return cmd.Start()
}

const (
	detachedProcess       = 0x00000008
	createNewProcessGroup = 0x00000200
)

// replacePortableExe swaps the loose oreneta.exe from the portable zip and
// queues the relaunch.
func replacePortableExe(archive, exe string) error {
	if err := replaceExecutableFrom(archive, exe); err != nil {
		return err
	}
	// A short delay covers process teardown; the old exe still holds the
	// single-instance lock for a moment after Quit returns.
	script := fmt.Sprintf(`timeout /t 3 /nobreak >nul & start "" "%s"`, exe)
	cmd := exec.Command("cmd", "/c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: detachedProcess | createNewProcessGroup}
	return cmd.Start()
}

// sweepReplacedExecutable deletes the previous exe left behind by a portable
// update. Called on startup, once the new copy is the one running.
func sweepReplacedExecutable() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	_ = os.Remove(exe + oldExeSuffix)
}
