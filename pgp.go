package main

// OpenPGP certificates and signature checks. The core holds the certificates
// and does the cryptography; the bridge carries the questions through.

import "errors"

func (a *App) pgpCerts(map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"certs": []any{}}, nil
	}
	return a.sidecar.Call("pgp.certs", map[string]any{})
}

func (a *App) pgpImport(payload map[string]any) (any, error) {
	armoured, _ := payload["armoured"].(string)
	if armoured == "" {
		return nil, errors.New("no certificate given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("pgp.import", map[string]any{"armoured": armoured})
}

func (a *App) pgpRemove(payload map[string]any) (any, error) {
	fingerprint, _ := payload["fingerprint"].(string)
	if fingerprint == "" {
		return nil, errors.New("no fingerprint given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("pgp.remove", map[string]any{"fingerprint": fingerprint})
}

// pgpVerify checks one message's signature. Asked when a reader opens a
// message that claims one, not on sync: verification needs the message as it
// stood on the wire, and fetching every message to answer a question nobody
// asked would be a download per message.
func (a *App) pgpVerify(payload map[string]any) (any, error) {
	account, _ := payload["account"].(string)
	if account == "" {
		return nil, errors.New("no account given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("pgp.verify", payload)
}
