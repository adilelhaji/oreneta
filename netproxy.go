package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Outbound proxy for the HTTP requests the Go bridge makes itself:
// autodiscovery, OAuth sign-in (code exchange and Google userinfo), account
// avatar downloads, and the update check and download.
//
// The proxy setting lives in the core (meron-core/src/proxy.rs): one app-wide
// proxy, and per account a choice to inherit it, go direct, or use its own.
// The bridge asks the core which route applies ("proxy.route") and builds an
// http.Transport from the answer. Both HTTP CONNECT and SOCKS5 are handled by
// net/http's own Proxy support; for SOCKS5 the target hostname is sent to the
// proxy, so names are resolved there and never by the local resolver.
//
// Fail closed: when the route cannot be read, or a proxy is set but cannot be
// used, the caller gets an error. It never falls back to a direct connection.
// A proxy that is set but unreachable also fails, because net/http does not
// retry without it.

// proxySetting is the core's proxy JSON (meron-core ProxyConfig::to_json).
type proxySetting struct {
	Mode     string `json:"mode"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// proxyURL turns the setting into the URL net/http's Transport.Proxy expects.
func (p *proxySetting) proxyURL() (*url.URL, error) {
	var scheme string
	switch p.Mode {
	case "http":
		scheme = "http"
	case "socks5":
		scheme = "socks5"
	default:
		return nil, fmt.Errorf("unsupported proxy mode %q", p.Mode)
	}
	host := strings.TrimSpace(p.Host)
	if host == "" || p.Port <= 0 || p.Port > 65535 {
		return nil, errors.New("the proxy setting is incomplete (host or port missing)")
	}
	if strings.ContainsAny(host, "/?#@ \t\r\n") {
		return nil, fmt.Errorf("invalid proxy host %q", host)
	}
	u := &url.URL{Scheme: scheme, Host: net.JoinHostPort(host, strconv.Itoa(p.Port))}
	if p.Username != "" {
		u.User = url.UserPassword(p.Username, p.Password)
	}
	return u, nil
}

// proxyRoute returns the proxy for a request on behalf of account ("" for the
// app-wide setting), or nil for a direct connection.
func (a *App) proxyRoute(account string) (*proxySetting, error) {
	if a.proxyLookup != nil {
		return a.proxyLookup(account)
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, errors.New("the proxy setting cannot be read because the mail engine is not running")
	}
	params := map[string]any{}
	if account != "" {
		params["account"] = account
	}
	raw, err := a.sidecar.Call("proxy.route", params)
	if err != nil {
		return nil, fmt.Errorf("read proxy setting: %w", err)
	}
	return decodeProxyRoute(raw)
}

func decodeProxyRoute(raw any) (*proxySetting, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("read proxy setting: %w", err)
	}
	var out struct {
		Proxy *proxySetting `json:"proxy"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("read proxy setting: %w", err)
	}
	return out.Proxy, nil
}

// proxyTransport builds a Transport for the given route. nil is a direct
// connection (which, as before, still honours HTTP(S)_PROXY from the
// environment); anything else must be a usable proxy or this errors.
func proxyTransport(p *proxySetting) (*http.Transport, error) {
	t := http.DefaultTransport.(*http.Transport).Clone()
	if p == nil {
		t.Proxy = http.ProxyFromEnvironment
		return t, nil
	}
	u, err := p.proxyURL()
	if err != nil {
		return nil, err
	}
	t.Proxy = http.ProxyURL(u)
	return t, nil
}

// httpTransport is the Transport for a request on behalf of account ("" for
// the app-wide setting).
func (a *App) httpTransport(account string) (*http.Transport, error) {
	route, err := a.proxyRoute(account)
	if err != nil {
		return nil, err
	}
	return proxyTransport(route)
}

// httpClient is an http.Client honouring the app's proxy for account ("" for
// the app-wide setting), with the given overall timeout (0 for none).
func (a *App) httpClient(account string, timeout time.Duration) (*http.Client, error) {
	t, err := a.httpTransport(account)
	if err != nil {
		return nil, err
	}
	return &http.Client{Transport: t, Timeout: timeout}, nil
}
