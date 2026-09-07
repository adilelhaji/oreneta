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

// The reader's own S/MIME identity or identities — the parallel to
// pgp.go's secret-key functions.

func (a *App) smimeIdentities(map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"identities": []any{}}, nil
	}
	return a.sidecar.Call("smime.identities", map[string]any{})
}

// smimeImportIdentity imports a PKCS#12 (.p12/.pfx) file. p12 is base64, the
// same shape smimeImport already uses for a bare certificate.
func (a *App) smimeImportIdentity(payload map[string]any) (any, error) {
	p12, _ := payload["p12"].(string)
	password, _ := payload["password"].(string)
	if p12 == "" || password == "" {
		return nil, errors.New("no identity file or password given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("smime.importIdentity", map[string]any{"p12": p12, "password": password})
}

func (a *App) smimeRemoveIdentity(payload map[string]any) (any, error) {
	fingerprint, _ := payload["fingerprint"].(string)
	if fingerprint == "" {
		return nil, errors.New("no fingerprint given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("smime.removeIdentity", map[string]any{"fingerprint": fingerprint})
}

// smimeDecrypt opens one S/MIME-encrypted message. No passphrase travels
// with the request: the identity's private key was unlocked once, at
// import, and lives ready-to-use in the OS keyring from then on.
func (a *App) smimeDecrypt(payload map[string]any) (any, error) {
	account, _ := payload["account"].(string)
	if account == "" {
		return nil, errors.New("no account given")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call("smime.decrypt", payload)
}
