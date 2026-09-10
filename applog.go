package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// maxLogViewLines caps how much of oreneta.log the in-app viewer and the export
// include; the newest lines matter for troubleshooting.
const maxLogViewLines = 1000

// logSinks fans a log line out to every sink, ignoring the ones that fail.
// io.MultiWriter is the wrong tool here: it stops at the first writer that
// errors, so on a Windows GUI build — where the process has no console and
// os.Stderr is an invalid handle whose every Write fails — pairing stderr with
// the log file left meron.log empty, exactly when a user needs it most.
type logSinks []io.Writer

func (sinks logSinks) Write(p []byte) (int, error) {
	for _, sink := range sinks {
		if sink == nil {
			continue
		}
		_, _ = sink.Write(p)
	}
	return len(p), nil
}

var logEmailRegexp = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)

var logSecretRegexp = regexp.MustCompile(`(?i)"?\b(password|passphrase|token|secret|client[_-]?secret|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)\b"?(\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)`)

// redactLogEmails masks the local part of every email address so the log keeps
// the domain for context but never the full address, e.g. "j***@gmail.com".
// Mirrors the mobile diagnostic log's redaction.
func redactLogEmails(text string) string {
	return logEmailRegexp.ReplaceAllStringFunc(text, func(email string) string {
		at := strings.Index(email, "@")
		if at <= 0 {
			return "***"
		}
		return email[:1] + "***" + email[at:]
	})
}

// redactLogSecrets removes values attached to common credential-like keys,
// including bearer/basic authorization values. The key and separator remain
// useful for diagnosing which stage failed without exporting the secret.
func redactLogSecrets(text string) string {
	return logSecretRegexp.ReplaceAllString(text, `${1}${2}[REDACTED]`)
}

func redactDiagnosticText(text string) string {
	return redactLogEmails(redactLogSecrets(text))
}

// appLogTail returns the newest maxLogViewLines of oreneta.log with email
// addresses redacted, ready to show in the Settings log viewer or export.
func appLogTail() (string, error) {
	data, err := os.ReadFile(filepath.Join(appConfigDir(), appLogFilename))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > maxLogViewLines {
		lines = lines[len(lines)-maxLogViewLines:]
	}
	return redactDiagnosticText(strings.Join(lines, "\n")), nil
}

func (a *App) logRead() (any, error) {
	tail, err := appLogTail()
	if err != nil {
		return nil, err
	}
	return map[string]any{"log": tail}, nil
}

// captureCrashes routes Go runtime crash tracebacks into oreneta.log. The runtime
// writes an unrecovered panic straight to fd 2, which is lost for a windowed
// app (no terminal attached), so the one thing worth having after a crash would
// otherwise never reach the log the user can export.
func captureCrashes(logFile *os.File) {
	if logFile == nil {
		return
	}
	// Errors here are not actionable — a missing traceback is no reason to
	// refuse to start — and the log stays usable either way.
	_ = debug.SetCrashOutput(logFile, debug.CrashOptions{})
}

// recoverInvoke turns a panic in a bridge call into a logged error instead of a
// dead app: one bad message or malformed payload should not take the window
// down. The traceback goes to the log so the crash is still diagnosable.
func (a *App) recoverInvoke(command string, err *error) {
	panicked := recover()
	if panicked == nil {
		return
	}
	safePanic := redactDiagnosticText(fmt.Sprint(panicked))
	a.logf("invoke %s panicked: %s\n%s", command, safePanic, debug.Stack())
	*err = fmt.Errorf("internal error in %s: %s", command, safePanic)
}

// logExport writes the redacted log tail to a user-chosen path via a native
// save dialog, with a disclosure header matching the mobile share flow.
func (a *App) logExport() (any, error) {
	tail, err := appLogTail()
	if err != nil {
		return nil, err
	}
	dest, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:                "Export log",
		DefaultFilename:      "oreneta-log.txt",
		CanCreateDirectories: true,
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "Text files (*.txt)", Pattern: "*.txt"},
		},
	})
	if err != nil {
		return nil, err
	}
	if dest == "" {
		return map[string]any{"saved": false}, nil // user cancelled
	}
	disclosure := "Account emails below are masked to only the first letter and domain (e.g. j***@gmail.com); credential-like values are replaced with [REDACTED].\n" +
		"Review before sharing.\n\n"
	if err := os.WriteFile(dest, []byte(disclosure+tail), 0o644); err != nil {
		return nil, fmt.Errorf("write log: %w", err)
	}
	a.logf("log.export: wrote %s", dest)
	return map[string]any{"saved": true, "path": dest}, nil
}
