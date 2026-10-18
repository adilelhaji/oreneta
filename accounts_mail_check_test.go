package main

import "testing"

// #270: the interval reaches the core as asked, and the bridge answers with
// what the core stored (it bounds the value).
func TestAccountSetMailCheckIntervalForwardsAndReportsWhatWasStored(t *testing.T) {
	app, writer := newMailHandlerTestApp(t,
		sidecarResponsePlan{Result: map[string]any{"ok": true, "minutes": float64(5)}},
		sidecarResponsePlan{Result: map[string]any{"ok": true, "minutes": float64(0)}},
	)
	res, err := app.accountSetMailCheckInterval(map[string]any{"id": "acc", "minutes": float64(2)})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["minutes"] != 5 {
		t.Fatalf("result = %#v, want the stored 5", res)
	}
	assertCall(t, writer.calls[0], "account.setMailCheckInterval", map[string]any{"account": "acc", "minutes": float64(2)})

	// "Manual only" is a value of its own, not a missing one.
	res, err = app.accountSetMailCheckInterval(map[string]any{"account_id": "acc", "minutes": float64(0)})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["minutes"] != 0 {
		t.Fatalf("result = %#v, want manual only", res)
	}
}

func TestAccountSetMailCheckIntervalRefusesWhatItCannotRead(t *testing.T) {
	app, writer := newMailHandlerTestApp(t)
	for _, payload := range []map[string]any{
		{"minutes": float64(15)},
		{"id": "acc"},
		{"id": "acc", "minutes": "15"},
		{"id": "acc", "minutes": float64(-1)},
	} {
		if _, err := app.accountSetMailCheckInterval(payload); err == nil {
			t.Fatalf("payload %#v accepted", payload)
		}
	}
	if len(writer.calls) != 0 {
		t.Fatalf("calls = %#v, want none", writer.calls)
	}
	if _, err := (&App{}).accountSetMailCheckInterval(map[string]any{"id": "acc", "minutes": float64(15)}); err == nil {
		t.Fatal("want an error without the engine")
	}
}

// The setting has to survive a restart: account.list must carry it (and the
// RSS interval, which this struct used to drop) through to the interface.
func TestAccountListKeepsTheCheckIntervals(t *testing.T) {
	app, _ := newMailHandlerTestApp(t, sidecarResponsePlan{Result: map[string]any{
		"accounts": []any{
			map[string]any{"id": "mail", "email": "a@example.com", "mail_check_interval_minutes": float64(0)},
			map[string]any{"id": "feeds", "rss_sync_interval_minutes": float64(30)},
		},
	}})
	res, err := app.accountList()
	if err != nil {
		t.Fatal(err)
	}
	accounts := res.(map[string]any)["accounts"].([]Account)
	if got := accounts[0].MailCheckIntervalMinutes; got == nil || *got != 0 {
		t.Fatalf("mail interval = %v, want manual only (0)", got)
	}
	if accounts[1].MailCheckIntervalMinutes != nil {
		t.Fatalf("an RSS account got a mail interval: %v", *accounts[1].MailCheckIntervalMinutes)
	}
	if got := accounts[1].RSSSyncIntervalMinutes; got == nil || *got != 30 {
		t.Fatalf("rss interval = %v, want 30", got)
	}
}
