package main

// S/MIME certificates and signature checks. Same shape as pgp.go: the core
// holds the certificates and does the cryptography, the bridge only carries
// the questions through.

import "errors"

func (a *App) smimeCerts(map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"certs": []any{}}, nil
	}
	return a.sidecar.Call("smime.certs", map[string]any{})
}

// smimeImport imports one certificate. der is base64, the same shape the core
// expects — payload.der travels through the same JSON channel everything else
// does, and JSON has no byte-string type.
func (a *App) smimeImport(payload map[string]any) (any, error) {
	der, _ := payload["der"].(string)
	if der == "" {
		return nil, errors.New("no certificate given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("smime.import", map[string]any{"der": der})
}

func (a *App) smimeRemove(payload map[string]any) (any, error) {
	fingerprint, _ := payload["fingerprint"].(string)
	if fingerprint == "" {
		return nil, errors.New("no fingerprint given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("smime.remove", map[string]any{"fingerprint": fingerprint})
}

// smimeVerify checks one message's signature. Asked when a reader opens a
// message that claims one, not on sync — the same reasoning as pgp.go's
// equivalent: verification needs the message as it stood on the wire.
func (a *App) smimeVerify(payload map[string]any) (any, error) {
	account, _ := payload["account"].(string)
	if account == "" {
		return nil, errors.New("no account given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("smime.verify", payload)
}
