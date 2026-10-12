package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"
)

// The test binary doubles as a minimal core: started with this variable set
// it answers every request with its own process id.
func init() {
	if os.Getenv("ORENETA_FAKE_SIDECAR") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request map[string]any
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			continue
		}
		fmt.Printf("{\"id\":%v,\"result\":{\"pid\":%d}}\n", request["id"], os.Getpid())
	}
	os.Exit(0)
}

func TestSidecarStopWaitsAndRestartStartsAFreshCore(t *testing.T) {
	isolatedHome(t)
	t.Setenv("ORENETA_FAKE_SIDECAR", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	sidecar := NewSidecar(exe, nil)
	if err := sidecar.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	first, err := sidecar.Call("ping", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := sidecar.Restart(context.Background(), 10*time.Second); err != nil {
		t.Fatal(err)
	}
	second, err := sidecar.Call("ping", nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.(map[string]any)["pid"] == second.(map[string]any)["pid"] {
		t.Fatal("a restart runs a new process")
	}
	if err := sidecar.Stop(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	if sidecar.Started() {
		t.Fatal("stopped")
	}
	if _, err := sidecar.Call("ping", nil); err == nil {
		t.Fatal("a stopped core answers nothing")
	}
}
