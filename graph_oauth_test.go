package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type graphCoreFixture struct {
	mu       sync.Mutex
	attempt  int
	redirect string
	states   map[string]string
	codes    []string
	calls    []string
}

func (f *graphCoreFixture) call(method string, p map[string]any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, method)
	a, _ := p["attempt"].(string)
	switch method {
	case "graph.authBegin":
		f.attempt++
		a = fmt.Sprintf("state-%d", f.attempt)
		f.redirect = p["redirect_uri"].(string)
		f.states[a] = "pending"
		q := url.Values{"state": {a}, "redirect_uri": {f.redirect}}
		return map[string]any{"attempt": a, "url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" + q.Encode()}, nil
	case "graph.authComplete":
		if f.states[a] != "pending" {
			return nil, errors.New("cancelled")
		}
		f.codes = append(f.codes, p["code"].(string))
		f.states[a] = "authorized"
		if p["denied"] == true {
			f.states[a] = "failed"
		}
		return map[string]any{"state": f.states[a]}, nil
	case "graph.authCancel":
		f.states[a] = "cancelled"
		return map[string]any{"ok": true}, nil
	case "graph.authPoll":
		return map[string]any{"state": f.states[a], "access_token": "never-visible-secret", "mail_backend_ready": false}, nil
	case "graph.disconnect":
		return map[string]any{"ok": true}, nil
	}
	return nil, errors.New("unexpected call")
}
func setupGraphBrowser(t *testing.T) (*graphBrowser, *graphCoreFixture, *string) {
	t.Helper()
	f := &graphCoreFixture{states: make(map[string]string)}
	opened := ""
	g := &graphBrowser{flows: make(map[string]*graphBrowserFlow), ttl: time.Minute, call: f.call, open: func(s string) { opened = s }}
	t.Cleanup(g.close)
	return g, f, &opened
}
func startGraph(t *testing.T, g *graphBrowser) string {
	t.Helper()
	r, err := g.begin("", "client")
	if err != nil {
		t.Fatal(err)
	}
	return r.(map[string]any)["attempt"].(string)
}
func graphRequest(t *testing.T, target string) int {
	t.Helper()
	client := &http.Client{Timeout: 3 * time.Second}
	r, err := client.Get(target)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	if strings.Contains(string(b), "code-secret") || strings.Contains(string(b), "provider-secret") {
		t.Fatal("callback reflected secrets")
	}
	if r.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("callback must not be cached")
	}
	return r.StatusCode
}
func TestGraphBrowserCallbackIsolationAndReplay(t *testing.T) {
	g, f, opened := setupGraphBrowser(t)
	a := startGraph(t, g)
	if !strings.HasPrefix(*opened, "https://login.microsoftonline.com/") {
		t.Fatal("Microsoft browser not opened")
	}
	u, _ := url.Parse(*opened)
	redirect := u.Query().Get("redirect_uri")
	for _, query := range []string{"state=wrong&code=code-secret", "state=" + a + "&code=a&code=b", "state=" + a + "&error=provider-secret&code=a", "state=" + a} {
		if graphRequest(t, redirect+"?"+query) != http.StatusBadRequest {
			t.Fatal("invalid callback accepted")
		}
	}
	if graphRequest(t, redirect+"?state="+a+"&code=code-secret") != http.StatusOK {
		t.Fatal("valid callback rejected")
	}
	if graphRequest(t, redirect+"?state="+a+"&code=code-secret") != http.StatusConflict {
		t.Fatal("callback replay accepted")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.mu.Lock()
		n := len(f.codes)
		f.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("callback did not reach core")
		}
		time.Sleep(time.Millisecond)
	}
	result, err := g.poll(a)
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := json.Marshal(result)
	if strings.Contains(string(wire), "secret") || strings.Contains(string(wire), "token") {
		t.Fatal("poll exposed credentials")
	}
	if !strings.Contains(string(wire), `"mail_backend_ready":false`) {
		t.Fatal("OAuth is not mail readiness")
	}
}
func TestGraphBrowserCancelReplaceDisconnectAndShutdown(t *testing.T) {
	g, f, _ := setupGraphBrowser(t)
	a := startGraph(t, g)
	b := startGraph(t, g)
	f.mu.Lock()
	state := f.states[a]
	f.mu.Unlock()
	if state != "cancelled" || len(g.flows) != 1 {
		t.Fatal("replacement left old flow live")
	}
	if _, err := g.disconnect("reader@example.test"); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	state = f.states[b]
	f.mu.Unlock()
	if state != "cancelled" || len(g.flows) != 0 {
		t.Fatal("disconnect left unbound flow live")
	}
	c := startGraph(t, g)
	g.close()
	f.mu.Lock()
	state = f.states[c]
	f.mu.Unlock()
	if state != "cancelled" {
		t.Fatal("shutdown did not cancel")
	}
	if _, err := g.begin("", "client"); err == nil {
		t.Fatal("began after shutdown")
	}
}
func TestGraphBrowserTimeoutAndDenied(t *testing.T) {
	g, f, opened := setupGraphBrowser(t)
	a := startGraph(t, g)
	u, _ := url.Parse(*opened)
	if graphRequest(t, u.Query().Get("redirect_uri")+"?state="+a+"&error=provider-secret") != http.StatusOK {
		t.Fatal("denial not received")
	}
	deadlineDenied := time.Now().Add(3 * time.Second)
	for {
		f.mu.Lock()
		state := f.states[a]
		f.mu.Unlock()
		if state == "failed" {
			break
		}
		if time.Now().After(deadlineDenied) {
			t.Fatal("denial did not reach core")
		}
		time.Sleep(time.Millisecond)
	}
	g.ttl = 20 * time.Millisecond
	a = startGraph(t, g)
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.mu.Lock()
		state := f.states[a]
		f.mu.Unlock()
		if state == "cancelled" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("attempt did not expire")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestGraphBrowserFailsClosedWithoutLeakingCoreError(t *testing.T) {
	g, _, _ := setupGraphBrowser(t)
	g.call = func(string, map[string]any) (any, error) { return nil, errors.New("provider-secret") }
	for _, operation := range []func() (any, error){func() (any, error) { return g.begin("", "client") }, func() (any, error) { return g.poll("a") }, func() (any, error) { return g.cancel("a") }, func() (any, error) { return g.disconnect("a") }} {
		_, err := operation()
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("unsafe failure", err)
		}
	}
	if _, err := g.begin("", ""); err == nil {
		t.Fatal("missing client accepted")
	}
}
func TestGraphBrowserRejectsProviderURLInjectionAndFrontendCompletion(t *testing.T) {
	g, _, _ := setupGraphBrowser(t)
	g.call = func(method string, p map[string]any) (any, error) {
		return map[string]any{"attempt": "a", "url": "https://evil.test/?state=a"}, nil
	}
	if _, err := g.begin("", "client"); err == nil {
		t.Fatal("external authorization URL accepted")
	}
	a := &App{}
	if _, err := a.invoke("graph.authComplete", map[string]any{"code": "code-secret"}); err == nil {
		t.Fatal("frontend can inject completion")
	}
	if sidecarCallTimeout("graph.authComplete") < 70*time.Second {
		t.Fatal("exchange cannot fit RPC timeout")
	}
}
