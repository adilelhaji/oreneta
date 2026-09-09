package main

// Graph browser transport only. PKCE, identity, tokens and persistence live in
// meron-core (docs/graph-authorization.md); this bridge never exchanges tokens.
import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type graphBrowserFlow struct {
	account  string
	server   *http.Server
	timer    *time.Timer
	consumed atomic.Bool
}

type graphBrowser struct {
	mu     sync.Mutex
	flows  map[string]*graphBrowserFlow
	call   func(string, map[string]any) (any, error)
	open   func(string)
	ttl    time.Duration
	closed bool
}

func (a *App) graphBrowser() *graphBrowser {
	a.graphOnce.Do(func() {
		a.graph = &graphBrowser{flows: make(map[string]*graphBrowserFlow), ttl: 10 * time.Minute,
			call: func(method string, payload map[string]any) (any, error) {
				if a.sidecar == nil || !a.sidecar.Started() {
					return nil, errors.New("Graph authorization: engine unavailable")
				}
				return a.sidecar.Call(method, payload)
			},
			open: func(target string) { wailsRuntime.BrowserOpenURL(a.ctx, target) },
		}
	})
	return a.graph
}

func (g *graphBrowser) begin(account, clientID string) (any, error) {
	if clientID == "" {
		return nil, errors.New("Microsoft client ID missing")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return nil, errors.New("Graph authorization: cancelled")
	}
	// Replacing a wizard invalidates its old listener and Rust generation first.
	for attempt, flow := range g.flows {
		if flow.account == account {
			if err := g.cancelLocked(attempt); err != nil {
				return nil, err
			}
		}
	}
	if len(g.flows) >= 32 {
		return nil, errors.New("Graph authorization: too many attempts")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("Graph authorization: callback unavailable")
	}
	redirect := "http://" + listener.Addr().String() + "/"
	answer, err := g.call("graph.authBegin", map[string]any{"account": account, "client_id": clientID, "redirect_uri": redirect})
	if err != nil {
		_ = listener.Close()
		return nil, errors.New("Graph authorization: could not start")
	}
	var begin struct {
		Attempt string `json:"attempt"`
		URL     string `json:"url"`
	}
	if graphDecode(answer, &begin) != nil || begin.Attempt == "" || begin.URL == "" {
		_ = listener.Close()
		return nil, errors.New("Graph authorization: invalid response")
	}
	target, err := url.Parse(begin.URL)
	if err != nil || target.Scheme != "https" || target.Host != "login.microsoftonline.com" || target.User != nil || target.Path != "/common/oauth2/v2.0/authorize" || target.Query().Get("state") != begin.Attempt || target.Query().Get("redirect_uri") != redirect {
		_, _ = g.call("graph.authCancel", map[string]any{"attempt": begin.Attempt})
		_ = listener.Close()
		return nil, errors.New("Graph authorization: invalid response")
	}
	flow := &graphBrowserFlow{account: account}
	flow.server = &http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 64 * 1024, ErrorLog: log.New(io.Discard, "", 0)}
	flow.server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		q, parseErr := url.ParseQuery(r.URL.RawQuery)
		if r.Method != http.MethodGet || r.URL.Path != "/" || r.Host != listener.Addr().String() || len(r.URL.RawQuery) > 40000 || parseErr != nil || len(q["state"]) != 1 || q.Get("state") != begin.Attempt || len(q["code"]) > 1 || len(q["error"]) > 1 || (q.Get("code") == "") == (q.Get("error") == "") {
			http.Error(w, "Invalid authorization callback.", http.StatusBadRequest)
			return
		}
		if !flow.consumed.CompareAndSwap(false, true) {
			http.Error(w, "Callback already received.", http.StatusConflict)
			return
		}
		// Return promptly; the UI polls Rust while the bounded exchange runs.
		go func() {
			_, _ = g.call("graph.authComplete", map[string]any{"attempt": begin.Attempt, "state": q.Get("state"), "code": q.Get("code"), "denied": q.Get("error") != ""})
		}()
		_, _ = fmt.Fprint(w, "Authorization response received. Return to Oreneta to check the result.")
	})
	g.flows[begin.Attempt] = flow
	flow.timer = time.AfterFunc(g.ttl, func() { _, _ = g.cancel(begin.Attempt) })
	go func() { _ = flow.server.Serve(listener) }()
	g.open(begin.URL)
	// Return only the opaque attempt, not the callback code or any credentials.
	return map[string]any{"attempt": begin.Attempt}, nil
}

func (g *graphBrowser) cancelLocked(attempt string) error {
	_, err := g.call("graph.authCancel", map[string]any{"attempt": attempt})
	if flow := g.flows[attempt]; flow != nil {
		flow.timer.Stop()
		_ = flow.server.Close()
		delete(g.flows, attempt)
	}
	if err != nil {
		return errors.New("Graph authorization: cancellation unavailable")
	}
	return nil
}

func (g *graphBrowser) cancel(attempt string) (any, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if err := g.cancelLocked(attempt); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (g *graphBrowser) poll(attempt string) (any, error) {
	answer, err := g.call("graph.authPoll", map[string]any{"attempt": attempt})
	if err != nil {
		return nil, errors.New("Graph authorization: status unavailable")
	}
	// Explicit whitelist: future core fields cannot accidentally leak credentials.
	var state struct {
		State     string  `json:"state"`
		Account   *string `json:"account"`
		Principal *struct {
			Tenant string `json:"tenant"`
			Object string `json:"object"`
			Email  string `json:"email"`
		} `json:"principal"`
		Error            *string `json:"error"`
		MailBackendReady bool    `json:"mail_backend_ready"`
	}
	if graphDecode(answer, &state) != nil {
		return nil, errors.New("Graph authorization: invalid response")
	}
	return state, nil
}

func (g *graphBrowser) disconnect(account string) (any, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for attempt, flow := range g.flows {
		if flow.account == "" || flow.account == account {
			if err := g.cancelLocked(attempt); err != nil {
				return nil, err
			}
		}
	}
	if _, err := g.call("graph.disconnect", map[string]any{"account": account}); err != nil {
		return nil, errors.New("Graph authorization: disconnect unavailable")
	}
	return map[string]any{"ok": true}, nil
}

func (g *graphBrowser) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	for attempt := range g.flows {
		_ = g.cancelLocked(attempt)
	}
}

func graphDecode(value any, target any) error {
	blob, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(blob, target)
}
