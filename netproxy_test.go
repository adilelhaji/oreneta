package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// directApp is an App whose proxy route is "no proxy", for tests that make
// real requests to local servers without a running core.
func directApp() *App {
	return &App{proxyLookup: func(string) (*proxySetting, error) { return nil, nil }}
}

// proxiedApp routes every request through p and records which account each
// lookup was for.
func proxiedApp(p *proxySetting) (*App, *[]string) {
	var mu sync.Mutex
	asked := []string{}
	app := &App{proxyLookup: func(account string) (*proxySetting, error) {
		mu.Lock()
		asked = append(asked, account)
		mu.Unlock()
		return p, nil
	}}
	return app, &asked
}

// testHTTPProxy is an HTTP proxy that records what it was asked for. Plain
// http:// requests are answered by the proxy itself (so the target is never
// contacted directly); CONNECT is tunnelled to `tunnelTo` when set, or refused.
type testHTTPProxy struct {
	*httptest.Server
	mu       sync.Mutex
	requests []string // "GET http://host/path" or "CONNECT host:port"
	auth     []string
	tunnelTo string
	answer   func(r *http.Request) (int, string)
}

func newTestHTTPProxy(t *testing.T) *testHTTPProxy {
	t.Helper()
	p := &testHTTPProxy{}
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		if r.Method == http.MethodConnect {
			p.requests = append(p.requests, "CONNECT "+r.Host)
		} else {
			p.requests = append(p.requests, r.Method+" "+r.URL.String())
		}
		p.auth = append(p.auth, r.Header.Get("Proxy-Authorization"))
		tunnelTo, answer := p.tunnelTo, p.answer
		p.mu.Unlock()

		if r.Method != http.MethodConnect {
			status, body := http.StatusOK, "via proxy"
			if answer != nil {
				status, body = answer(r)
			}
			w.WriteHeader(status)
			_, _ = io.WriteString(w, body)
			return
		}
		if tunnelTo == "" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		upstream, err := net.Dial("tcp", tunnelTo)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		_, _ = conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
		pipe(conn, buf.Reader, upstream)
	}))
	t.Cleanup(p.Close)
	return p
}

func (p *testHTTPProxy) seen() ([]string, []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.requests...), append([]string(nil), p.auth...)
}

func (p *testHTTPProxy) setting() *proxySetting {
	host, port, _ := net.SplitHostPort(p.Listener.Addr().String())
	n, _ := strconv.Atoi(port)
	return &proxySetting{Mode: "http", Host: host, Port: n}
}

func pipe(client net.Conn, clientReader io.Reader, upstream net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, clientReader); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
	<-done
	client.Close()
	upstream.Close()
}

// countingServer counts direct hits.
func countingServer(t *testing.T, body string) (*httptest.Server, func() int) {
	t.Helper()
	var mu sync.Mutex
	hits := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(s.Close)
	return s, func() int { mu.Lock(); defer mu.Unlock(); return hits }
}

func TestHTTPProxyCarriesPlainRequests(t *testing.T) {
	target, hits := countingServer(t, "direct")
	proxy := newTestHTTPProxy(t)
	setting := proxy.setting()
	setting.Username, setting.Password = "ana", "secret"
	app, asked := proxiedApp(setting)

	client, err := app.httpClient("acct-1", 5*time.Second)
	if err != nil {
		t.Fatalf("httpClient: %v", err)
	}
	res, err := client.Get(target.URL + "/x")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "via proxy" {
		t.Fatalf("body = %q, want the proxy's answer", body)
	}
	if hits() != 0 {
		t.Fatalf("target was contacted directly %d times", hits())
	}
	reqs, auth := proxy.seen()
	if len(reqs) != 1 || reqs[0] != "GET "+target.URL+"/x" {
		t.Fatalf("proxy saw %v", reqs)
	}
	if !strings.HasPrefix(auth[0], "Basic ") {
		t.Fatalf("no proxy credentials sent: %q", auth[0])
	}
	if len(*asked) != 1 || (*asked)[0] != "acct-1" {
		t.Fatalf("route looked up for %v, want the account", *asked)
	}
}

func TestHTTPProxyTunnelsHTTPSWithConnect(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "secure")
	}))
	defer target.Close()
	proxy := newTestHTTPProxy(t)
	proxy.tunnelTo = target.Listener.Addr().String()
	app, _ := proxiedApp(proxy.setting())

	transport, err := app.httpTransport("")
	if err != nil {
		t.Fatalf("httpTransport: %v", err)
	}
	transport.TLSClientConfig = target.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = "example.com" // httptest's cert covers example.com
	res, err := (&http.Client{Transport: transport, Timeout: 5 * time.Second}).Get("https://mail.example.com:443/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "secure" {
		t.Fatalf("body = %q", body)
	}
	reqs, _ := proxy.seen()
	// The hostname goes to the proxy unresolved.
	if len(reqs) != 1 || reqs[0] != "CONNECT mail.example.com:443" {
		t.Fatalf("proxy saw %v, want one CONNECT for the hostname", reqs)
	}
}

// testSOCKS5 is a minimal SOCKS5 server (no auth) that records the requested
// destination and connects every request to `to`.
func testSOCKS5(t *testing.T, to string) (*proxySetting, func() []string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var mu sync.Mutex
	var dests []string
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				r := bufio.NewReader(conn)
				dest, err := socks5Handshake(r, conn)
				if err != nil {
					conn.Close()
					return
				}
				mu.Lock()
				dests = append(dests, dest)
				mu.Unlock()
				upstream, err := net.Dial("tcp", to)
				if err != nil {
					_, _ = conn.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
					conn.Close()
					return
				}
				_, _ = conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
				pipe(conn, r, upstream)
			}(conn)
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	return &proxySetting{Mode: "socks5", Host: "127.0.0.1", Port: port}, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), dests...)
	}
}

func socks5Handshake(r *bufio.Reader, w io.Writer) (string, error) {
	head := make([]byte, 2)
	if _, err := io.ReadFull(r, head); err != nil || head[0] != 5 {
		return "", errors.New("bad greeting")
	}
	if _, err := io.ReadFull(r, make([]byte, head[1])); err != nil {
		return "", err
	}
	_, _ = w.Write([]byte{5, 0})
	req := make([]byte, 4)
	if _, err := io.ReadFull(r, req); err != nil || req[1] != 1 {
		return "", errors.New("bad request")
	}
	var host string
	switch req[3] {
	case 3: // domain name: the proxy resolves it
		n, _ := r.ReadByte()
		name := make([]byte, n)
		if _, err := io.ReadFull(r, name); err != nil {
			return "", err
		}
		host = "domain:" + string(name)
	case 1:
		ip := make([]byte, 4)
		if _, err := io.ReadFull(r, ip); err != nil {
			return "", err
		}
		host = "ip:" + net.IP(ip).String()
	default:
		return "", errors.New("unsupported address type")
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(r, port); err != nil {
		return "", err
	}
	return host + ":" + strconv.Itoa(int(binary.BigEndian.Uint16(port))), nil
}

func TestSOCKS5ProxyCarriesRequestsAndResolvesNames(t *testing.T) {
	target, hits := countingServer(t, "through socks")
	setting, dests := testSOCKS5(t, target.Listener.Addr().String())
	app, _ := proxiedApp(setting)

	client, err := app.httpClient("", 5*time.Second)
	if err != nil {
		t.Fatalf("httpClient: %v", err)
	}
	// A name the local resolver cannot know: only the proxy can reach it.
	res, err := client.Get("http://mail.oreneta-proxy.test:8025/x")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "through socks" || hits() != 1 {
		t.Fatalf("body=%q hits=%d", body, hits())
	}
	if got := dests(); len(got) != 1 || got[0] != "domain:mail.oreneta-proxy.test:8025" {
		t.Fatalf("SOCKS5 destinations %v, want the hostname unresolved", got)
	}
}

func TestNoProxyGoesDirect(t *testing.T) {
	target, hits := countingServer(t, "direct")
	client, err := directApp().httpClient("", 5*time.Second)
	if err != nil {
		t.Fatalf("httpClient: %v", err)
	}
	res, err := client.Get(target.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	res.Body.Close()
	if hits() != 1 {
		t.Fatalf("hits = %d, want 1", hits())
	}
}

func TestUnusableProxyFailsInsteadOfGoingDirect(t *testing.T) {
	target, hits := countingServer(t, "direct")

	bad := []*proxySetting{
		{Mode: "http", Host: "", Port: 8080},
		{Mode: "socks5", Host: "proxy.example", Port: 0},
		{Mode: "ftp", Host: "proxy.example", Port: 21},
		{Mode: "http", Host: "bad/host", Port: 8080},
	}
	for _, p := range bad {
		app, _ := proxiedApp(p)
		if _, err := app.httpClient("", time.Second); err == nil {
			t.Errorf("httpClient(%+v) built a client, want an error", *p)
		}
	}

	// The route cannot be read at all: no core running.
	if _, err := (&App{}).httpClient("", time.Second); err == nil {
		t.Error("no core: httpClient built a client, want an error")
	}
	failing := &App{proxyLookup: func(string) (*proxySetting, error) { return nil, errors.New("core said no") }}
	if _, err := failing.httpTransport("acct"); err == nil {
		t.Error("lookup error: transport built, want an error")
	}

	// A proxy that is set but not listening: the request fails, and the target
	// is never contacted directly.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	for _, mode := range []string{"http", "socks5"} {
		app, _ := proxiedApp(&proxySetting{Mode: mode, Host: "127.0.0.1", Port: port})
		client, err := app.httpClient("", 2*time.Second)
		if err != nil {
			t.Fatalf("%s: httpClient: %v", mode, err)
		}
		if res, err := client.Get(target.URL); err == nil {
			res.Body.Close()
			t.Errorf("%s: request succeeded through a dead proxy", mode)
		}
	}
	if hits() != 0 {
		t.Fatalf("target contacted directly %d times", hits())
	}
}

func TestDecodeProxyRoute(t *testing.T) {
	got, err := decodeProxyRoute(map[string]any{"proxy": nil})
	if err != nil || got != nil {
		t.Fatalf("direct: got %+v, %v", got, err)
	}
	got, err = decodeProxyRoute(map[string]any{"proxy": map[string]any{
		"mode": "socks5", "host": "p.example", "port": float64(1080), "username": "u", "password": "p",
	}})
	if err != nil || got == nil || got.Mode != "socks5" || got.Host != "p.example" || got.Port != 1080 || got.Username != "u" {
		t.Fatalf("socks5: got %+v, %v", got, err)
	}
	u, err := got.proxyURL()
	if err != nil || u.String() != "socks5://u:p@p.example:1080" {
		t.Fatalf("proxyURL = %v, %v", u, err)
	}
}

func TestAutodiscoverGoesThroughTheProxy(t *testing.T) {
	proxy := newTestHTTPProxy(t) // refuses every CONNECT
	app, _ := proxiedApp(proxy.setting())
	got, err := app.autodiscover(map[string]any{"email": "ana+news@example.test"})
	if err != nil {
		t.Fatalf("autodiscover: %v", err)
	}
	if cfg := got.(*DiscoveredConfig); cfg.Source != "guess" {
		t.Fatalf("source = %q, want guess (SRV skipped behind a proxy)", cfg.Source)
	}
	reqs, _ := proxy.seen()
	want := []string{
		"CONNECT autoconfig.example.test:443",
		"CONNECT example.test:443",
		"CONNECT autoconfig.thunderbird.net:443",
	}
	if strings.Join(reqs, "|") != strings.Join(want, "|") {
		t.Fatalf("proxy saw %v, want %v", reqs, want)
	}

	broken, _ := proxiedApp(&proxySetting{Mode: "http"})
	if _, err := broken.autodiscover(map[string]any{"email": "ana@example.test"}); err == nil {
		t.Fatal("autodiscover with an unusable proxy succeeded, want an error")
	}
}

func TestAvatarDownloadUsesTheAccountsProxy(t *testing.T) {
	isolateTestProfile(t)
	proxy := newTestHTTPProxy(t)
	proxy.answer = func(*http.Request) (int, string) { return http.StatusNotFound, "" }
	app, asked := proxiedApp(proxy.setting())
	const remote = "http://avatars.example.test/me.png"
	if got, err := app.saveAvatar("acct-7", remote); err == nil || got != "" {
		t.Fatalf("got %q, %v; want no picture and an error, not the remote URL", got, err)
	}
	reqs, _ := proxy.seen()
	if len(reqs) != 1 || reqs[0] != "GET "+remote {
		t.Fatalf("proxy saw %v", reqs)
	}
	if len(*asked) != 1 || (*asked)[0] != "acct-7" {
		t.Fatalf("route looked up for %v, want acct-7", *asked)
	}

	// Unusable proxy: no request at all, and no picture.
	broken, _ := proxiedApp(&proxySetting{Mode: "socks5"})
	if got, err := broken.saveAvatar("acct-7", remote); err == nil || got != "" {
		t.Fatalf("got %q, %v; want no picture and an error", got, err)
	}
	if reqs, _ := proxy.seen(); len(reqs) != 1 {
		t.Fatalf("unexpected extra requests %v", reqs)
	}
}

func TestUpdateCheckAndDownloadGoThroughTheProxy(t *testing.T) {
	isolateTestProfile(t)
	proxy := newTestHTTPProxy(t)
	proxy.answer = func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/latest.json") {
			return http.StatusOK, `{"version":"0.0.1","platforms":{}}`
		}
		return http.StatusOK, "payload"
	}
	app, _ := proxiedApp(proxy.setting())
	u := newUpdater(app)
	if _, err := u.fetchManifest("http://updates.example.test/latest.json"); err != nil {
		t.Fatalf("fetchManifest: %v", err)
	}
	// Digest won't match; what matters is the route the request took.
	_, _ = u.downloadTo(updateAsset{URL: "http://updates.example.test/oreneta.AppImage", SHA256: strings.Repeat("0", 64), Size: 7})
	reqs, _ := proxy.seen()
	want := "GET http://updates.example.test/latest.json|GET http://updates.example.test/oreneta.AppImage"
	if strings.Join(reqs, "|") != want {
		t.Fatalf("proxy saw %v", reqs)
	}

	broken, _ := proxiedApp(&proxySetting{Mode: "http", Port: 3128})
	ub := newUpdater(broken)
	if _, err := ub.fetchManifest("http://updates.example.test/latest.json"); err == nil {
		t.Fatal("update check with an unusable proxy succeeded")
	}
	if _, err := ub.downloadTo(updateAsset{URL: "http://updates.example.test/x", SHA256: strings.Repeat("0", 64), Size: 1}); err == nil {
		t.Fatal("update download with an unusable proxy succeeded")
	}
}

func TestAutoconfigURLsEscapeTheAddress(t *testing.T) {
	urls := autoconfigURLs("ana+news&x=1@example.com", "example.com")
	for _, u := range urls[:2] {
		if !strings.HasSuffix(u.url, "?emailaddress=ana%2Bnews%26x%3D1%40example.com") {
			t.Errorf("unescaped address in %q", u.url)
		}
	}
	if urls[2].url != "https://autoconfig.thunderbird.net/v1.1/example.com" {
		t.Errorf("ISPDB url = %q", urls[2].url)
	}
	if _, err := directApp().autodiscover(map[string]any{"email": "ana@evil.example/x?"}); err == nil {
		t.Error("a domain with URL syntax was accepted")
	}
}
