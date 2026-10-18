package main

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

// #269: editing server settings without retyping the password must reach the
// core with no password key at all — the core keeps the stored one — rather
// than being refused here as missing credentials.
func TestAccountAddPasswordLeavesAnOmittedPasswordToTheCore(t *testing.T) {
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"ok": true}},
		sidecarResponsePlan{Result: map[string]any{"ok": true}},
	)
	if _, err := app.accountAddPassword(map[string]any{
		"email":     "user@example.com",
		"imap_host": "imap.example.com",
		"smtp_host": "smtp.example.com",
		"username":  "user@example.com",
	}); err != nil {
		t.Fatal(err)
	}
	params := writer.calls[0].Params
	if _, ok := params["password"]; ok {
		t.Fatalf("params = %#v, want no password key", params)
	}
	if _, ok := params["validate"]; ok {
		t.Fatalf("params = %#v, want the core's default validation", params)
	}
}

// "Save anyway" is the only way to store an account the test did not pass,
// and only ever as the person's explicit choice.
func TestAccountAddPasswordSaveAnywaySkipsValidationOnlyWhenAsked(t *testing.T) {
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"ok": true}},
		sidecarResponsePlan{Result: map[string]any{"ok": true}},
	)
	if _, err := app.accountAddPassword(map[string]any{
		"email":           "user@example.com",
		"imap_host":       "imap.example.com",
		"smtp_host":       "smtp.example.com",
		"username":        "user@example.com",
		"password":        "secret",
		"skip_validation": true,
	}); err != nil {
		t.Fatal(err)
	}
	if got := writer.calls[0].Params["validate"]; got != false {
		t.Fatalf("validate = %#v, want false", got)
	}
}

// The test checks exactly what a save would store: the same ports, TLS modes
// and pins, the account's own proxy, and nothing that is not a connection
// setting. The password reaches the core but not the log.
func TestAccountTestConnectionSendsWhatASaveWouldStore(t *testing.T) {
	report := map[string]any{"ok": true, "incoming": map[string]any{"ok": true}, "outgoing": map[string]any{"ok": true}}
	app, writer := newMailHandlerTestApp(t, sidecarResponsePlan{Result: report})
	var logs bytes.Buffer
	app.logger = log.New(&logs, "", 0)
	res, err := app.accountTestConnection(map[string]any{
		"email":         "user@example.com",
		"display_name":  "Work",
		"imap_host":     "imap.example.com",
		"imap_port":     143,
		"smtp_host":     "smtp.example.com",
		"smtp_port":     587,
		"username":      "user",
		"password":      "typed-secret",
		"tls":           false,
		"starttls":      true,
		"smtp_tls":      false,
		"smtp_starttls": true,
		"cert_pin":      " AB12 ",
		"proxy":         map[string]any{"mode": "direct"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["ok"] != true {
		t.Fatalf("result = %#v, want the core's report", res)
	}
	assertCall(t, writer.calls[0], "account.testConnection", map[string]any{
		"account":       "user@example.com",
		"host":          "imap.example.com",
		"port":          float64(143),
		"user":          "user",
		"password":      "typed-secret",
		"tls":           false,
		"starttls":      true,
		"smtp_host":     "smtp.example.com",
		"smtp_port":     float64(587),
		"smtp_tls":      false,
		"smtp_starttls": true,
		"cert_pin":      "AB12",
		"proxy":         map[string]any{"mode": "direct"},
	})
	if !strings.Contains(logs.String(), "account.testConnection") {
		t.Fatalf("log = %q, want the test recorded", logs.String())
	}
	if strings.Contains(logs.String(), "typed-secret") {
		t.Fatalf("log names the password: %s", logs.String())
	}
}

// Editing without retyping: the core tests the stored password.
func TestAccountTestConnectionLeavesAnOmittedPasswordToTheCore(t *testing.T) {
	app, writer := newMailHandlerTestApp(t, sidecarResponsePlan{Result: map[string]any{"ok": false}})
	if _, err := app.accountTestConnection(map[string]any{
		"email":     "user@example.com",
		"imap_host": "pop.example.com",
		"smtp_host": "smtp.example.com",
		"username":  "user@example.com",
		"incoming":  "pop3",
	}); err != nil {
		t.Fatal(err)
	}
	params := writer.calls[0].Params
	if _, ok := params["password"]; ok {
		t.Fatalf("params = %#v, want no password key", params)
	}
	if params["auth_type"] != "pop3" || params["port"] != float64(995) {
		t.Fatalf("params = %#v, want POP3 on its usual port", params)
	}
	if _, ok := params["proxy"]; ok {
		t.Fatalf("params = %#v, want no proxy key (the app-wide proxy)", params)
	}
}

func TestAccountTestConnectionNeedsBothServersAndAUser(t *testing.T) {
	app, writer := newMailHandlerTestApp(t)
	for _, payload := range []map[string]any{
		{"email": "user@example.com", "imap_host": "imap.example.com", "username": "u", "password": "p"},
		{"email": "user@example.com", "imap_host": "imap.example.com", "smtp_host": "smtp.example.com", "password": "p"},
		{"email": "not-an-address", "imap_host": "imap.example.com", "smtp_host": "smtp.example.com", "username": "u"},
	} {
		if _, err := app.accountTestConnection(payload); err == nil {
			t.Fatalf("payload %#v accepted", payload)
		}
	}
	if len(writer.calls) != 0 {
		t.Fatalf("calls = %#v, want none", writer.calls)
	}
}

func TestAccountTestConnectionNeedsTheEngine(t *testing.T) {
	app := &App{}
	if _, err := app.accountTestConnection(map[string]any{
		"email": "user@example.com", "imap_host": "i", "smtp_host": "s", "username": "u", "password": "p",
	}); err == nil {
		t.Fatal("want an error without the engine")
	}
}

// The log keeps each server's verdict and the failed step, never what the
// server said (it can name the user).
func TestConnectionTestSummaryNamesOnlyTheFailedStep(t *testing.T) {
	summary := connectionTestSummary(map[string]any{
		"incoming": map[string]any{"ok": true, "steps": []any{map[string]any{"step": "dns", "status": "ok"}}},
		"outgoing": map[string]any{"ok": false, "steps": []any{
			map[string]any{"step": "dns", "status": "ok"},
			map[string]any{"step": "auth", "status": "failed", "kind": "rejected", "detail": "535 bad user ana@example.com"},
		}},
	})
	if summary != "incoming=ok outgoing=failed at auth (rejected)" {
		t.Fatalf("summary = %q", summary)
	}
	if got := connectionTestSummary(nil); got != "incoming=unknown outgoing=unknown" {
		t.Fatalf("summary of nothing = %q", got)
	}
}
