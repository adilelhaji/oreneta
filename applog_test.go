package main

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecoverInvokeTurnsPanicIntoError(t *testing.T) {
	var buf bytes.Buffer
	app := &App{logger: log.New(&buf, "", 0)}

	call := func() (err error) {
		defer app.recoverInvoke("mail.send", &err)
		panic("nil map write")
	}

	err := call()
	if err == nil {
		t.Fatal("recoverInvoke swallowed the panic without returning an error")
	}
	if !strings.Contains(err.Error(), "mail.send") || !strings.Contains(err.Error(), "nil map write") {
		t.Fatalf("error = %q, want it to name the command and the panic", err)
	}
	logged := buf.String()
	if !strings.Contains(logged, "invoke mail.send panicked") {
		t.Fatalf("log = %q, want the panic recorded", logged)
	}
	if !strings.Contains(logged, "recoverInvoke") {
		t.Fatalf("log = %q, want a stack trace so the crash stays diagnosable", logged)
	}
}

func TestRecoverInvokeLeavesSuccessfulCallsAlone(t *testing.T) {
	var buf bytes.Buffer
	app := &App{logger: log.New(&buf, "", 0)}

	call := func() (err error) {
		defer app.recoverInvoke("mail.list", &err)
		return nil
	}

	if err := call(); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("log = %q, want nothing logged for a clean call", buf.String())
	}
}

func TestRedactDiagnosticTextRemovesEmailsAndCredentialValues(t *testing.T) {
	input := `connect user=ana@example.com password=correct-horse,with-comma token=abc123 Authorization: Bearer xyz789 {"password":"json-secret","accessToken":"camel-secret","ClientSecret":"client-secret","refreshToken":"abc\"def"}`
	got := redactDiagnosticText(input)
	for _, leaked := range []string{"ana@example.com", "correct-horse", "with-comma", "abc123", "xyz789", "json-secret", "camel-secret", "client-secret", `abc\"def`} {
		if strings.Contains(got, leaked) {
		t.Fatalf("redacted log leaked sensitive value: %q", got)
		}
	}
	for _, want := range []string{"a***@example.com", "password=[REDACTED]", "token=[REDACTED]", "Authorization: [REDACTED]"} {
		if !strings.Contains(got, want) {
			t.Fatalf("redacted log = %q, want %q", got, want)
		}
	}
}

func TestRedactDiagnosticTextPreservesOrdinaryContext(t *testing.T) {
	input := "stage=sync folder=Inbox result=timeout"
	if got := redactDiagnosticText(input); got != input {
		t.Fatalf("ordinary diagnostic context changed: got %q, want %q", got, input)
	}
}

func TestAppLogTailReadsAndRedactsCanonicalLog(t *testing.T) {
	isolateTestProfile(t)
	path := filepath.Join(appConfigDir(), appLogFilename)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("sync user=ana@example.com password=secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := appLogTail()
	if err != nil {
		t.Fatalf("appLogTail() = %v", err)
	}
	if !strings.Contains(got, "a***@example.com") || strings.Contains(got, "secret") {
		t.Fatalf("appLogTail() = %q, want redacted canonical log", got)
	}
}

func TestAppLogTailKeepsOnlyTheNewestBoundedLines(t *testing.T) {
	isolateTestProfile(t)
	path := filepath.Join(appConfigDir(), appLogFilename)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	lines := make([]string, maxLogViewLines+2)
	for i := range lines {
		lines[i] = fmt.Sprintf("line-%d", i)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := appLogTail()
	if err != nil {
		t.Fatal(err)
	}
	gotLines := strings.Split(got, "\n")
	if len(gotLines) != maxLogViewLines || gotLines[0] != "line-2" || gotLines[len(gotLines)-1] != fmt.Sprintf("line-%d", maxLogViewLines+1) {
		t.Fatalf("bounded log tail starts/ends at %q/%q, want line-2/line-%d", gotLines[0], gotLines[len(gotLines)-1], maxLogViewLines+1)
	}
}

func TestRecoverInvokeRedactsPanicDetails(t *testing.T) {
	var buf bytes.Buffer
	app := &App{logger: log.New(&buf, "", 0)}

	call := func() (err error) {
		defer app.recoverInvoke("mail.send", &err)
		panic(`password=panic-secret`)
	}

	err := call()
	if err == nil || strings.Contains(err.Error(), "panic-secret") {
		t.Fatalf("error = %v, want a redacted panic", err)
	}
	if strings.Contains(buf.String(), "panic-secret") {
		t.Fatalf("log leaked panic secret: %q", buf.String())
	}
}
