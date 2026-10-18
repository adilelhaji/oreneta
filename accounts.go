package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// passwordConnection is the manual IMAP/POP3/SMTP form resolved into what
// account.connect takes: default ports, each server's TLS mode and the
// accepted certificate pins. Saving and the connection test (#269) both build
// it here, so the test checks exactly what a save would store.
type passwordConnection struct {
	id                                           string
	pop3                                         bool
	imapPort, smtpPort                           uint16
	imapTLS, imapStartTLS, smtpTLS, smtpStartTLS bool
	params                                       map[string]any
}

func resolvePasswordConnection(req AddPasswordAccountRequest) (passwordConnection, error) {
	if !strings.Contains(req.Email, "@") {
		return passwordConnection{}, errors.New("invalid email")
	}
	if req.IMAPHost == "" || req.SMTPHost == "" {
		return passwordConnection{}, errors.New("server required")
	}
	if req.Username == "" {
		return passwordConnection{}, errors.New("credentials required")
	}
	c := passwordConnection{
		id:       accountID(req.Email),
		pop3:     req.Incoming == "pop3",
		imapPort: req.IMAPPort,
		smtpPort: req.SMTPPort,
	}
	if c.imapPort == 0 {
		c.imapPort = 993
		if c.pop3 {
			c.imapPort = 995
		}
	}
	if c.smtpPort == 0 {
		c.smtpPort = 465
	}
	legacyTLS := true
	if req.TLS != nil {
		legacyTLS = *req.TLS
	}
	var imapExplicitTLS *bool
	if req.StartTLS != nil {
		imapExplicitTLS = req.TLS
	}
	c.imapTLS, c.imapStartTLS = selectedTLSMode(legacyTLS, imapExplicitTLS, req.StartTLS, c.imapPort)
	c.smtpTLS, c.smtpStartTLS = selectedTLSMode(legacyTLS, req.SMTPTLS, req.SMTPStartTLS, c.smtpPort)
	c.params = map[string]any{
		"id":            c.id,
		"host":          req.IMAPHost,
		"port":          c.imapPort,
		"user":          req.Username,
		"tls":           c.imapTLS,
		"starttls":      c.imapStartTLS,
		"smtp_host":     req.SMTPHost,
		"smtp_port":     c.smtpPort,
		"smtp_tls":      c.smtpTLS,
		"smtp_starttls": c.smtpStartTLS,
	}
	// No password at all tells the core to use the one it already holds for
	// this account — editing server settings without retyping it; "" would
	// blank it. Whether one is held is for the core to say: an account it
	// does not have fails its validation without a password, and is not saved.
	if req.Password != "" {
		c.params["password"] = req.Password
	}
	if c.pop3 {
		// POP3 mail is downloaded into the app; there is no IMAP to watch.
		c.params["auth_type"] = "pop3"
	}
	if pin := strings.TrimSpace(req.CertPin); pin != "" {
		c.params["cert_pin"] = pin
	}
	if pin := strings.TrimSpace(req.SMTPCertPin); pin != "" {
		c.params["smtp_cert_pin"] = pin
	}
	return c, nil
}

func (a *App) accountAddPassword(payload map[string]any) (any, error) {
	var req AddPasswordAccountRequest
	if err := decode(payload, &req); err != nil {
		return nil, err
	}
	c, err := resolvePasswordConnection(req)
	if err != nil {
		return nil, err
	}
	a.logf("account.addPassword: connecting account=%s imap=%s:%d smtp=%s:%d", c.id, req.IMAPHost, c.imapPort, req.SMTPHost, c.smtpPort)
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	connect := c.params
	connect["email"] = req.Email
	connect["display_name"] = req.DisplayName
	connect["sender_name"] = req.SenderName
	connect["provider"] = "custom"
	if req.SkipValidation {
		// The person chose "Save anyway" after a connection test that did not
		// pass (#269). The core still refuses to save without a password.
		connect["validate"] = false
		a.logf("account.addPassword: account=%s saved without a passing connection test, as the user chose", c.id)
	}
	if _, err := a.sidecar.Call("account.connect", connect); err != nil {
		return nil, err
	}
	if !c.pop3 {
		_, _ = a.sidecar.Call("watch.start", map[string]any{"account": c.id})
	}

	authType := "password"
	if c.pop3 {
		authType = "pop3"
	}
	account := Account{
		ID:                c.id,
		Email:             req.Email,
		DisplayName:       req.DisplayName,
		SenderName:        req.SenderName,
		Provider:          "custom",
		AuthType:          authType,
		IncludedInUnified: true,
		IMAPHost:          req.IMAPHost,
		IMAPPort:          c.imapPort,
		SMTPHost:          req.SMTPHost,
		SMTPPort:          c.smtpPort,
		TLS:               c.imapTLS,
		StartTLS:          c.imapStartTLS,
		SMTPTLS:           c.smtpTLS,
		SMTPStartTLS:      c.smtpStartTLS,
	}
	return map[string]any{"account": account}, nil
}

// accountTestConnection checks the manual setup's incoming and outgoing
// servers step by step — DNS, TCP, TLS, sign-in — and stores nothing (#269).
// The report names the step that failed on each server; the password is
// neither logged nor returned.
func (a *App) accountTestConnection(payload map[string]any) (any, error) {
	var req AddPasswordAccountRequest
	if err := decode(payload, &req); err != nil {
		return nil, err
	}
	c, err := resolvePasswordConnection(req)
	if err != nil {
		return nil, err
	}
	params := c.params
	// The stored password, when none is typed, is looked up by account.
	params["account"] = c.id
	delete(params, "id")
	// The account's proxy choice, as for the certificate probe: absent
	// follows the app-wide proxy.
	if proxy, ok := payload["proxy"]; ok && proxy != nil {
		params["proxy"] = proxy
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	a.logf("account.testConnection: account=%s imap=%s:%d smtp=%s:%d", c.id, req.IMAPHost, c.imapPort, req.SMTPHost, c.smtpPort)
	res, err := a.sidecar.Call("account.testConnection", params)
	if err != nil {
		return nil, err
	}
	a.logf("account.testConnection: account=%s %s", c.id, connectionTestSummary(res))
	return res, nil
}

// connectionTestSummary is the log line of a connection test: each server's
// verdict and the first step that failed. Not the servers' own words, which
// can name the user, and never the password.
func connectionTestSummary(res any) string {
	report, _ := res.(map[string]any)
	parts := make([]string, 0, 2)
	for _, side := range []string{"incoming", "outgoing"} {
		server, _ := report[side].(map[string]any)
		verdict := "unknown"
		if ok, known := server["ok"].(bool); known && ok {
			verdict = "ok"
		} else if known {
			verdict = "failed"
		}
		steps, _ := server["steps"].([]any)
		for _, raw := range steps {
			step, _ := raw.(map[string]any)
			if step["status"] == "failed" {
				verdict = fmt.Sprintf("failed at %v (%v)", step["step"], step["kind"])
				break
			}
		}
		parts = append(parts, side+"="+verdict)
	}
	return strings.Join(parts, " ")
}

// accountAddEWS sets up an Exchange account against its EWS endpoint. The
// sidecar validates with a live EWS round trip before storing, the same
// contract accountAddPassword gets from IMAP validation.
func (a *App) accountAddEWS(payload map[string]any) (any, error) {
	var req AddEWSAccountRequest
	if err := decode(payload, &req); err != nil {
		return nil, err
	}
	if !strings.Contains(req.Email, "@") {
		return nil, errors.New("invalid email")
	}
	req.EWSURL = strings.TrimSpace(req.EWSURL)
	if !strings.HasPrefix(req.EWSURL, "https://") {
		// Credentials go over this connection with Basic auth; anything but
		// HTTPS would put them on the wire in the clear.
		return nil, errors.New("EWS URL must start with https://")
	}
	if req.Username == "" {
		// DOMAIN\user is common on premises; the address works elsewhere.
		req.Username = req.Email
	}
	id := accountID(req.Email)
	a.logf("account.addEWS: connecting account=%s url=%s", id, req.EWSURL)
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	connect := map[string]any{
		"id":           id,
		"ews_url":      req.EWSURL,
		"user":         req.Username,
		"email":        req.Email,
		"display_name": req.DisplayName,
		"sender_name":  req.SenderName,
		"provider":     "exchange",
		"auth_type":    "password",
	}
	// Sending no password at all tells the core to keep the stored one, which
	// is what editing an account without retyping it means; sending "" would
	// blank it. Only the core knows whether a secret is already held, so the
	// requirement is left to it rather than guessed here.
	if req.Password != "" {
		connect["password"] = req.Password
	}
	if _, err := a.sidecar.Call("account.connect", connect); err != nil {
		return nil, err
	}
	_, _ = a.sidecar.Call("watch.start", map[string]any{"account": id})

	account := Account{
		ID:                id,
		Email:             req.Email,
		DisplayName:       req.DisplayName,
		SenderName:        req.SenderName,
		Provider:          "exchange",
		AuthType:          "password",
		EWSURL:            req.EWSURL,
		IncludedInUnified: true,
	}
	return map[string]any{"account": account}, nil
}

// accountProbeCert fetches the certificate a mail server presents so the
// account dialog can show it and let the user pin it. Servers with a
// self-signed certificate (Proton Mail Bridge on 127.0.0.1, for one) are
// unreachable until their exact certificate is accepted.
func (a *App) accountProbeCert(payload map[string]any) (any, error) {
	var req struct {
		Host     string `json:"host"`
		Port     uint16 `json:"port"`
		Protocol string `json:"protocol"`
		StartTLS bool   `json:"starttls"`
		// The account's proxy choice, passed through untyped like everywhere
		// else. Absent follows the app-wide proxy, which is also what a
		// connection with no account override does.
		Proxy any `json:"proxy"`
	}
	if err := decode(payload, &req); err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.Host) == "" {
		return nil, errors.New("server required")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("account.probeCert", map[string]any{
		"host":     req.Host,
		"port":     req.Port,
		"protocol": req.Protocol,
		"starttls": req.StartTLS,
		"proxy":    req.Proxy,
	})
}

// accountSetCertPin stores a certificate the user accepted for an account that
// already exists — a send refused by a submission server whose certificate
// cannot be validated, say. Only the server named by the payload is pinned; an
// omitted key leaves that server's stored pin alone.
func (a *App) accountSetCertPin(payload map[string]any) (any, error) {
	var req struct {
		ID          string `json:"id"`
		CertPin     string `json:"cert_pin"`
		SMTPCertPin string `json:"smtp_cert_pin"`
	}
	if err := decode(payload, &req); err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.ID) == "" {
		return nil, errors.New("account required")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	params := map[string]any{"id": req.ID}
	if pin := strings.TrimSpace(req.CertPin); pin != "" {
		params["cert_pin"] = pin
	}
	if pin := strings.TrimSpace(req.SMTPCertPin); pin != "" {
		params["smtp_cert_pin"] = pin
	}
	return a.sidecar.Call("account.setCertPin", params)
}

func selectedTLSMode(legacyTLS bool, explicitTLS, explicitStartTLS *bool, port uint16) (bool, bool) {
	// A lone false STARTTLS flag does not identify the intended alternative;
	// retain legacy port inference unless its paired TLS flag is also present.
	if explicitTLS == nil && (explicitStartTLS == nil || !*explicitStartTLS) {
		return tlsMode(legacyTLS, port)
	}
	tls := legacyTLS
	if explicitTLS != nil {
		tls = *explicitTLS
	}
	starttls := explicitStartTLS != nil && *explicitStartTLS
	if starttls {
		tls = false
	}
	return tls, starttls
}

func (a *App) accountRemove(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	// The unified DB is the single source of truth: the sidecar deletes the
	// account row and cascades its cached state (mail folders/messages or rss
	// subscriptions/items), plus the keychain secret.
	result := map[string]any{"ok": true}
	if a.sidecar != nil && a.sidecar.Started() {
		res, err := a.sidecar.Call("account.remove", map[string]any{"id": id})
		if err != nil {
			a.logf("account.remove: sidecar cleanup failed for %s: %v", id, err)
		} else if answer, ok := res.(map[string]any); ok && answer["kept"] != nil {
			// What the person wrote stays on this computer (ADR-0011): the
			// interface says so rather than letting it look deleted.
			result["kept"] = answer["kept"]
		}
	}
	return result, nil
}

// accountAddSharedMailbox adds a shared mailbox an Exchange account has been
// granted full-access permission on — see meron-core's
// account.addSharedMailbox for why this needs no credentials of its own.
func (a *App) accountAddSharedMailbox(payload map[string]any) (any, error) {
	parentAccount, _ := payload["parent_account"].(string)
	address, _ := payload["address"].(string)
	displayName, _ := payload["display_name"].(string)
	if parentAccount == "" {
		return nil, errors.New("no account given")
	}
	if !strings.Contains(address, "@") {
		return nil, errors.New("invalid address")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	// Deterministic from the address, the same as any other account's id —
	// see accountID — so this does not need to parse it back out of the
	// sidecar's response.
	id := accountID(address)
	if _, err := a.sidecar.Call("account.addSharedMailbox", map[string]any{
		"parent_account": parentAccount,
		"address":        address,
		"display_name":   displayName,
	}); err != nil {
		return nil, err
	}
	_, _ = a.sidecar.Call("watch.start", map[string]any{"account": id})
	return map[string]any{"id": id}, nil
}

func (a *App) accountSetImages(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	enabled, _ := payload["enabled"].(bool)
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	if _, err := a.sidecar.Call("account.setImages", map[string]any{"account": id, "enabled": enabled}); err != nil {
		return nil, err
	}
	a.logf("account.setImages: account=%s enabled=%t", id, enabled)
	return map[string]any{"ok": true}, nil
}

func (a *App) accountReorder(payload map[string]any) (any, error) {
	accounts, _ := payload["accounts"].([]any)
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	if _, err := a.sidecar.Call("account.reorder", map[string]any{"accounts": accounts}); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// accountSetProxy points one account at its own proxy, at the app-wide one, or
// at a direct connection. The shape of "proxy" is validated in the engine.
func (a *App) accountSetProxy(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	proxy, _ := payload["proxy"].(map[string]any)
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	if _, err := a.sidecar.Call("account.setProxy", map[string]any{"account": id, "proxy": proxy}); err != nil {
		return nil, err
	}
	// Credentials are never logged; the mode alone is enough to debug routing.
	a.logf("account.setProxy: account=%s mode=%v", id, proxy["mode"])
	// A picture that could not be fetched may go through the new route now.
	a.requestAvatarSettle(avatarSettleDelay)
	return map[string]any{"ok": true}, nil
}

func (a *App) accountSetName(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	name, _ := payload["name"].(string)
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	if _, err := a.sidecar.Call("account.setName", map[string]any{"account": id, "name": name}); err != nil {
		return nil, err
	}
	a.logf("account.setName: account=%s name=%s", id, name)
	return map[string]any{"ok": true}, nil
}

func (a *App) accountSetSenderName(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	name, _ := payload["name"].(string)
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	if _, err := a.sidecar.Call("account.setSenderName", map[string]any{"account": id, "name": name}); err != nil {
		return nil, err
	}
	a.logf("account.setSenderName: account=%s name=%s", id, name)
	return map[string]any{"ok": true}, nil
}

func (a *App) accountSetAvatar(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	avatarURL, _ := payload["avatar_url"].(string)
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	stored, pending, err := a.storeAvatar(id, avatarURL)
	if err != nil {
		return nil, err
	}
	a.logf("account.setAvatar: account=%s pending=%t", id, pending)
	res := map[string]any{"ok": true, "pending": pending}
	if !pending {
		// The copy a remote picture became: the interface shows it without
		// reading the account list again.
		res["avatar_url"] = stored
	}
	return res, nil
}

// accountSetAliases replaces the whole send-as alias list for an account. The
// sidecar normalizes entries (trim, drop blank emails, dedupe).
func (a *App) accountSetAliases(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	aliases := payload["aliases"]
	if aliases == nil {
		aliases = []any{}
	}
	if _, err := a.sidecar.Call("account.setAliases", map[string]any{"account": id, "aliases": aliases}); err != nil {
		return nil, err
	}
	a.logf("account.setAliases: account=%s", id)
	return map[string]any{"ok": true}, nil
}

// accountSetSignature sets or clears one account's signature override. A nil
// "signature" clears it, so the account follows the app-wide signature; the
// engine validates the shape.
func (a *App) accountSetSignature(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	signature, _ := payload["signature"].(map[string]any)
	if _, err := a.sidecar.Call("account.setSignature", map[string]any{"account": id, "signature": signature}); err != nil {
		return nil, err
	}
	// The signature text is user content; only the chosen mode is logged.
	a.logf("account.setSignature: account=%s mode=%v", id, signature["mode"])
	return map[string]any{"ok": true}, nil
}

// accountSetPref forwards a boolean per-account toggle (unified-inbox inclusion,
// mute, pause) to the sidecar, which persists it and applies any side effects
// (e.g. pausing stops the IDLE watcher). `method` is the sidecar method name.
func (a *App) accountSetPref(payload map[string]any, method string) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	enabled, _ := payload["enabled"].(bool)
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	if _, err := a.sidecar.Call(method, map[string]any{"account": id, "enabled": enabled}); err != nil {
		return nil, err
	}
	a.logf("%s: account=%s enabled=%t", method, id, enabled)
	return map[string]any{"ok": true}, nil
}

func (a *App) accountSetSaveSentCopy(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	value, ok := payload["value"]
	if !ok {
		value = nil
	}
	switch value.(type) {
	case nil, bool:
	default:
		return nil, errors.New("value must be true, false, or null")
	}
	if _, err := a.sidecar.Call("account.setSaveSentCopy", map[string]any{"account": id, "value": value}); err != nil {
		return nil, err
	}
	a.logf("account.setSaveSentCopy: account=%s value=%v", id, value)
	return map[string]any{"ok": true}, nil
}

func (a *App) accountSetChatWallpaper(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	wallpaper, ok := payload["wallpaper"]
	if !ok {
		wallpaper = nil
	}
	if _, err := a.sidecar.Call("account.setChatWallpaper", map[string]any{"account": id, "wallpaper": wallpaper}); err != nil {
		return nil, err
	}
	a.logf("account.setChatWallpaper: account=%s", id)
	return map[string]any{"ok": true}, nil
}

func (a *App) accountSetRSSSyncInterval(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		id, _ = payload["account_id"].(string)
	}
	if id == "" {
		return nil, errors.New("account id required")
	}
	minutes, ok := numberPayload(payload["minutes"])
	if !ok {
		return nil, errors.New("minutes required")
	}
	if minutes < 5 {
		minutes = 5
	} else if minutes > 1440 {
		minutes = 1440
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	if _, err := a.sidecar.Call("account.setRSSSyncInterval", map[string]any{"account": id, "minutes": minutes}); err != nil {
		return nil, err
	}
	a.logf("account.setRSSSyncInterval: account=%s minutes=%d", id, minutes)
	return map[string]any{"ok": true, "minutes": minutes}, nil
}

func numberPayload(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case float32:
		return int(n), true
	default:
		return 0, false
	}
}

func (a *App) suggestContacts(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"contacts": []any{}}, nil
	}
	return a.sidecar.Call("contacts.suggest", payload)
}

// accountList returns every account (mail + rss) from the sidecar's unified DB,
// the single source of truth.
func (a *App) accountList() (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"accounts": []Account{}}, nil
	}
	res, err := a.sidecar.Call("account.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	return map[string]any{"accounts": decodeAccounts(res)}, nil
}

func decodeAccount(raw any) Account {
	obj, _ := raw.(map[string]any)
	return accountFromMap(obj["account"])
}

func decodeAccounts(raw any) []Account {
	obj, _ := raw.(map[string]any)
	list, _ := obj["accounts"].([]any)
	out := make([]Account, 0, len(list))
	for _, item := range list {
		out = append(out, accountFromMap(item))
	}
	return out
}

func accountFromMap(item any) Account {
	var acc Account
	data, _ := json.Marshal(item)
	_ = json.Unmarshal(data, &acc)
	return withoutRemoteAvatar(acc)
}
