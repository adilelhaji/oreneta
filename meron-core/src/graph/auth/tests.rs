use super::*;
use rsa::{RsaPrivateKey, pkcs1v15::Pkcs1v15Sign, traits::PublicKeyParts};
use serde_json::json;
use std::sync::{
    LazyLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

const CLIENT: &str = "11111111-1111-4111-8111-111111111111";
const TENANT: &str = "22222222-2222-4222-8222-222222222222";
const OBJECT: &str = "33333333-3333-4333-8333-333333333333";
const EMAIL: &str = "reader@example.test";
fn record() -> Record {
    Record {
        version: 1,
        account: EMAIL.into(),
        principal: Principal {
            tenant: TENANT.into(),
            object: OBJECT.into(),
            email: EMAIL.into(),
        },
        client_id: CLIENT.into(),
        access_token: "access-secret".into(),
        refresh_token: "refresh-secret".into(),
        scopes: "Mail.Read".into(),
        expires_at: now() + 3600,
    }
}
#[derive(Default)]
struct Memory {
    records: Mutex<HashMap<String, Record>>,
    fail: AtomicBool,
    saves: AtomicUsize,
}
impl Vault for Arc<Memory> {
    fn load(&self, a: &str) -> Result<Option<Record>> {
        Ok(self.records.lock().unwrap().get(a).cloned())
    }
    fn save(&self, r: &Record) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Failure::Storage);
        }
        self.records
            .lock()
            .unwrap()
            .insert(r.account.clone(), r.clone());
        self.saves.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn delete(&self, a: &str) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Failure::Storage);
        }
        self.records.lock().unwrap().remove(a);
        Ok(())
    }
}
struct Fake {
    answer: Mutex<Result<Record>>,
    calls: AtomicUsize,
    gate: Option<Arc<(Mutex<bool>, std::sync::Condvar)>>,
}
impl Fake {
    fn new() -> Self {
        Self {
            answer: Mutex::new(Ok(record())),
            calls: AtomicUsize::new(0),
            gate: None,
        }
    }
}
impl Provider for Fake {
    fn exchange(&self, _: &Flow, _: &str) -> Result<Record> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            let mut open = gate.0.lock().unwrap();
            while !*open {
                open = gate.1.wait(open).unwrap();
            }
        }
        self.answer.lock().unwrap().clone()
    }
    fn refresh(&self, _: &Record, _: &crate::proxy::ProxyChoice) -> Result<Record> {
        self.exchange(&flow(), "refresh")
    }
}
fn flow() -> Flow {
    Flow {
        state: "state".into(),
        verifier: "verifier".into(),
        nonce: "nonce".into(),
        redirect: "http://127.0.0.1:2345".into(),
        client_id: CLIENT.into(),
        selected: Some(EMAIL.into()),
        deadline: now() + 600,
        proxy: crate::proxy::ProxyChoice::Direct,
    }
}
fn setup() -> (Manager<Fake, Arc<Memory>>, Arc<Memory>, Begin) {
    let memory = Arc::new(Memory::default());
    let manager = Manager::new(Fake::new(), memory.clone());
    let begin = manager
        .begin(
            Some(EMAIL.into()),
            CLIENT,
            "http://127.0.0.1:2345",
            crate::proxy::ProxyChoice::Direct,
        )
        .unwrap();
    (manager, memory, begin)
}
#[test]
fn begin_uses_unique_pkce_nonce_scopes_and_exact_loopback() {
    let (manager, _, a) = setup();
    let url = Url::parse(&a.url).unwrap();
    let q: HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(q["scope"], SCOPES);
    assert_eq!(q["state"], a.attempt);
    assert_eq!(q["code_challenge_method"], "S256");
    let p = manager.pending.lock().unwrap();
    let f = &p[&a.attempt].flow;
    assert_eq!(
        q["code_challenge"],
        B64.encode(Sha256::digest(f.verifier.as_bytes()))
    );
    assert!(!a.url.contains(&f.verifier));
    assert_ne!(f.state, f.nonce);
    drop(p);
    for uri in [
        "https://127.0.0.1:1234",
        "http://localhost:1234",
        "http://127.0.0.1",
        "http://127.0.0.1:1234/evil",
        "http://user@127.0.0.1:1234",
        "http://127.0.0.1:1234?x=y",
    ] {
        assert!(
            manager
                .begin(None, CLIENT, uri, crate::proxy::ProxyChoice::Direct)
                .is_err()
        );
    }
    let b = manager
        .begin(
            Some(EMAIL.into()),
            CLIENT,
            "http://127.0.0.1:2345",
            crate::proxy::ProxyChoice::Direct,
        )
        .unwrap();
    assert_ne!(a.attempt, b.attempt);
    assert_eq!(manager.poll(&a.attempt).state, "cancelled");
}
#[test]
fn callback_is_single_use_scoped_and_secret_free() {
    let (m, v, a) = setup();
    assert_eq!(
        m.complete(&a.attempt, "wrong", "code", false).err(),
        Some(Failure::InvalidRequest)
    );
    assert_eq!(m.poll(&a.attempt).state, "pending");
    let result = m.complete(&a.attempt, &a.attempt, "code", false).unwrap();
    assert_eq!(result.state, "authorized");
    assert!(!result.mail_backend_ready);
    let wire = serde_json::to_string(&result).unwrap();
    assert!(!wire.contains("secret"));
    assert!(!wire.contains("token"));
    assert_eq!(
        m.complete(&a.attempt, &a.attempt, "code", false).err(),
        Some(Failure::Replayed)
    );
    assert_eq!(v.saves.load(Ordering::SeqCst), 1);
}
#[test]
fn deny_expire_and_cancel_preserve_previous_grant() {
    for case in 0..3 {
        let (m, v, a) = setup();
        v.save(&record()).unwrap();
        let expected = match case {
            0 => Failure::Denied,
            1 => {
                m.pending
                    .lock()
                    .unwrap()
                    .get_mut(&a.attempt)
                    .unwrap()
                    .flow
                    .deadline = 0;
                Failure::Expired
            }
            _ => {
                m.cancel(&a.attempt);
                Failure::Cancelled
            }
        };
        assert_eq!(
            m.complete(&a.attempt, &a.attempt, "code", case == 0).err(),
            Some(expected)
        );
        assert_eq!(v.saves.load(Ordering::SeqCst), 1);
        assert_eq!(m.provider.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn identity_change_and_failed_storage_never_replace_previous_grant() {
    for case in 0..3 {
        let (m, v, a) = setup();
        v.save(&record()).unwrap();
        let mut replacement = record();
        replacement.access_token = "new-secret".into();
        match case {
            0 => replacement.principal.object = CLIENT.into(),
            1 => replacement.account = "other@example.test".into(),
            _ => v.fail.store(true, Ordering::SeqCst),
        }
        *m.provider.answer.lock().unwrap() = Ok(replacement);
        assert_eq!(
            m.complete(&a.attempt, &a.attempt, "code", false).err(),
            Some(if case == 2 {
                Failure::Storage
            } else {
                Failure::DifferentAccount
            })
        );
        assert_eq!(
            v.load(EMAIL).unwrap().unwrap().access_token,
            "access-secret"
        );
        assert_eq!(m.poll(&a.attempt).state, "failed");
    }
}
#[test]
fn cancelling_during_exchange_prevents_late_commit() {
    let memory = Arc::new(Memory::default());
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let mut provider = Fake::new();
    provider.gate = Some(gate.clone());
    let m = Arc::new(Manager::new(provider, memory.clone()));
    let a = m
        .begin(
            Some(EMAIL.into()),
            CLIENT,
            "http://127.0.0.1:1234",
            crate::proxy::ProxyChoice::Direct,
        )
        .unwrap();
    let worker = m.clone();
    let attempt = a.attempt.clone();
    let handle = std::thread::spawn(move || worker.complete(&attempt, &attempt, "code", false));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while m.provider.calls.load(Ordering::SeqCst) == 0 {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    m.cancel(&a.attempt);
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    assert_eq!(handle.join().unwrap().err(), Some(Failure::Cancelled));
    assert_eq!(memory.saves.load(Ordering::SeqCst), 0);
}
#[test]
fn refresh_rotates_only_after_storage_and_preserves_revoked_or_failed_grants() {
    for fail in [false, true] {
        let (m, v, _) = setup();
        let mut old = record();
        old.expires_at = 0;
        v.save(&old).unwrap();
        let mut fresh = record();
        fresh.refresh_token = "rotated-secret".into();
        *m.provider.answer.lock().unwrap() = Ok(fresh);
        v.fail.store(fail, Ordering::SeqCst);
        let result = m.record(EMAIL, &crate::proxy::ProxyChoice::Direct);
        if fail {
            assert_eq!(result.err(), Some(Failure::Storage));
        } else {
            assert_eq!(result.unwrap().refresh_token, "rotated-secret");
        }
        assert_eq!(
            v.load(EMAIL).unwrap().unwrap().refresh_token,
            if fail {
                "refresh-secret"
            } else {
                "rotated-secret"
            }
        );
    }
    let (m, v, _) = setup();
    let mut old = record();
    old.expires_at = 0;
    v.save(&old).unwrap();
    *m.provider.answer.lock().unwrap() = Err(Failure::Reauthenticate);
    assert_eq!(
        m.record(EMAIL, &crate::proxy::ProxyChoice::Direct).err(),
        Some(Failure::Reauthenticate)
    );
    assert!(v.load(EMAIL).unwrap().is_some());
    m.disconnect(EMAIL).unwrap();
    assert!(v.load(EMAIL).unwrap().is_none());
}
#[test]
fn record_validation_rejects_corrupt_unscoped_and_wrong_binding_without_secrets() {
    for variant in 0..6 {
        let mut r = record();
        match variant {
            0 => r.version = 2,
            1 => r.account = "other@example.test".into(),
            2 => r.scopes = "https://outlook.office.com/IMAP.AccessAsUser.All".into(),
            3 => r.principal.object = "invalid".into(),
            4 => r.refresh_token.clear(),
            _ => r.access_token = "injected\r\n".into(),
        }
        assert_eq!(r.validate_stored(EMAIL), Err(Failure::Storage));
    }
    assert_ne!(vault_key(EMAIL), vault_key("other@example.test"));
    assert!(!vault_key(EMAIL).contains('@'));
}

static RSA: LazyLock<RsaPrivateKey> =
    LazyLock::new(|| RsaPrivateKey::new(&mut rand::rng(), 2048).unwrap());
fn claims() -> serde_json::Value {
    json!({"iss":format!("https://login.microsoftonline.com/{TENANT}/v2.0"),"sub":"fixture-subject","aud":CLIENT,"exp":now()+3600,"iat":now(),"nbf":now(),"nonce":"nonce","tid":TENANT,"oid":OBJECT,"preferred_username":EMAIL})
}
fn sign(c: serde_json::Value) -> String {
    let input = format!(
        "{}.{}",
        B64.encode(br#"{"alg":"RS256","kid":"fixture"}"#),
        B64.encode(c.to_string())
    );
    let signature = RSA
        .sign(
            Pkcs1v15Sign::new::<Sha256>(),
            &Sha256::digest(input.as_bytes()),
        )
        .unwrap();
    format!("{input}.{}", B64.encode(signature))
}
fn keys() -> Vec<u8> {
    json!({"keys":[{"kid":"fixture","kty":"RSA","n":B64.encode(RSA.n().to_be_bytes_trimmed_vartime()),"e":B64.encode(RSA.e().to_be_bytes_trimmed_vartime()),"issuer":"https://login.microsoftonline.com/{tenantid}/v2.0","use":"sig","alg":"RS256"}]}).to_string().into_bytes()
}
#[test]
fn signed_oidc_identity_validates_issuer_audience_nonce_time_and_principal() {
    let jwt = sign(claims());
    let p = verify_identity(&jwt, &keys(), CLIENT, Some("nonce"), "access", now()).unwrap();
    assert_eq!(p.email, EMAIL);
    assert_eq!(p.object, OBJECT);
    for (field, value) in [
        ("iss", json!("https://evil.test")),
        ("aud", json!(TENANT)),
        ("azp", json!(TENANT)),
        ("sub", json!("")),
        ("nonce", json!("wrong")),
        ("exp", json!(1)),
        ("nbf", json!(now() + 3600)),
        ("iat", json!(now() + 3600)),
        ("oid", json!("email-is-not-identity")),
        ("tid", json!("../../evil")),
        ("preferred_username", json!("not-mail")),
        ("at_hash", json!("wrong")),
    ] {
        let mut c = claims();
        c[field] = value;
        assert_eq!(
            verify_identity(&sign(c), &keys(), CLIENT, Some("nonce"), "access", now()).err(),
            Some(Failure::InvalidIdentity),
            "{field}"
        );
    }
    let mut c = claims();
    c["at_hash"] = json!(B64.encode(&Sha256::digest(b"access")[..16]));
    assert!(verify_identity(&sign(c), &keys(), CLIENT, Some("nonce"), "access", now()).is_ok());
    let mut parts: Vec<String> = jwt.split('.').map(str::to_owned).collect();
    parts[1] = B64.encode(claims().to_string().replace(EMAIL, "thief@example.test"));
    assert_eq!(
        verify_identity(
            &parts.join("."),
            &keys(),
            CLIENT,
            Some("nonce"),
            "access",
            now()
        )
        .err(),
        Some(Failure::InvalidIdentity)
    );
    for bad in ["", "a.b", "a.b.c.d", "a.b.c"] {
        assert!(verify_identity(bad, &keys(), CLIENT, Some("nonce"), "access", now()).is_err());
    }
}

#[test]
fn first_association_requires_address_but_reconnect_pins_immutable_identity() {
    let (m, v, a) = setup();
    let mut renamed = record();
    renamed.principal.email = "new-alias@example.test".into();
    *m.provider.answer.lock().unwrap() = Ok(renamed);
    assert_eq!(
        m.complete(&a.attempt, &a.attempt, "code", false).err(),
        Some(Failure::DifferentAccount)
    );
    v.save(&record()).unwrap();
    let a = m
        .begin(
            Some(EMAIL.into()),
            CLIENT,
            "http://127.0.0.1:2345",
            crate::proxy::ProxyChoice::Direct,
        )
        .unwrap();
    assert_eq!(
        m.complete(&a.attempt, &a.attempt, "code", false)
            .unwrap()
            .state,
        "authorized"
    );
    assert_eq!(
        m.record(EMAIL, &crate::proxy::ProxyChoice::Direct)
            .unwrap()
            .principal
            .email,
        "new-alias@example.test"
    );
}

#[test]
fn disconnect_cancels_unbound_and_selected_flows_without_deleting_other_grants() {
    let (m, v, a) = setup();
    v.save(&record()).unwrap();
    let b = m
        .begin(
            None,
            CLIENT,
            "http://127.0.0.1:2345",
            crate::proxy::ProxyChoice::Direct,
        )
        .unwrap();
    let mut other = record();
    other.account = "other@example.test".into();
    other.principal.email = other.account.clone();
    v.save(&other).unwrap();
    m.disconnect(EMAIL).unwrap();
    for a in [a, b] {
        assert_eq!(
            m.complete(&a.attempt, &a.attempt, "code", false).err(),
            Some(Failure::Cancelled)
        );
    }
    assert!(v.load(EMAIL).unwrap().is_none());
    assert!(v.load(&other.account).unwrap().is_some());
}

#[test]
fn malformed_or_rebound_refresh_never_replaces_valid_storage() {
    for case in 0..5 {
        let (m, v, _) = setup();
        let mut old = record();
        old.expires_at = 0;
        v.save(&old).unwrap();
        let mut fresh = record();
        match case {
            0 => fresh.principal.tenant = CLIENT.into(),
            1 => fresh.client_id = TENANT.into(),
            2 => fresh.scopes = "Mail.ReadBasic".into(),
            3 => fresh.expires_at = 0,
            _ => fresh.access_token.clear(),
        }
        *m.provider.answer.lock().unwrap() = Ok(fresh);
        assert!(m.record(EMAIL, &crate::proxy::ProxyChoice::Direct).is_err());
        assert_eq!(v.saves.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn oauth_token_responses_require_granted_scope_and_preserve_omitted_rotation() {
    let base = json!({"access_token":"fresh-access","token_type":"Bearer","scope":"Mail.Read openid","expires_in":3600});
    let fresh = Tokens::parse(base.to_string().as_bytes())
        .unwrap()
        .refreshed(&record())
        .unwrap();
    assert_eq!(fresh.refresh_token, "refresh-secret");
    assert_eq!(fresh.access_token, "fresh-access");
    for (field, value) in [
        ("access_token", json!("")),
        ("access_token", json!(null)),
        ("token_type", json!("Basic")),
        ("expires_in", json!(0)),
        ("expires_in", json!(i64::MAX)),
        (
            "scope",
            json!("https://outlook.office.com/IMAP.AccessAsUser.All"),
        ),
        ("scope", json!("Mail.ReadBasic")),
    ] {
        let mut bad = base.clone();
        bad[field] = value;
        assert!(
            Tokens::parse(bad.to_string().as_bytes()).is_err(),
            "{field}"
        );
    }
    let mut rotated = base.clone();
    rotated["refresh_token"] = json!("fresh-refresh");
    assert_eq!(
        Tokens::parse(rotated.to_string().as_bytes())
            .unwrap()
            .refreshed(&record())
            .unwrap()
            .refresh_token,
        "fresh-refresh"
    );
    rotated["refresh_token"] = json!("");
    assert!(
        Tokens::parse(rotated.to_string().as_bytes())
            .unwrap()
            .refreshed(&record())
            .is_err()
    );
}

#[test]
fn oauth_http_errors_are_bounded_sanitized_and_never_follow_redirects() {
    use crate::graph::tests::Fixture;
    for (code, body, expected) in [
        (
            400,
            r#"{"error":"invalid_grant","error_description":"secret"}"#,
            Failure::Reauthenticate,
        ),
        (400, r#"{"error":"consent_required"}"#, Failure::Denied),
        (429, "secret", Failure::Unavailable),
        (500, "secret", Failure::Unavailable),
        (302, "secret", Failure::Unavailable),
    ] {
        let f = Fixture::new(|_| {
            vec![(
                code,
                "Location: https://evil.test/secret\r\n".into(),
                body.into(),
            )]
        });
        assert_eq!(
            Microsoft
                .http(
                    &crate::proxy::ProxyChoice::Direct,
                    f.base.as_str(),
                    Some(&[("code", "fixture-code")])
                )
                .err(),
            Some(expected)
        );
        assert_eq!(f.requests().len(), 1);
    }
    let f = Fixture::new(|_| vec![(200, String::new(), "x".repeat(MAX_JSON as usize + 1))]);
    assert_eq!(
        Microsoft
            .http(&crate::proxy::ProxyChoice::Direct, f.base.as_str(), None)
            .err(),
        Some(Failure::InvalidResponse)
    );
    let f = Fixture::new(|_| vec![(200, String::new(), "{}".into())]);
    assert_eq!(
        Microsoft
            .http(&crate::proxy::ProxyChoice::Direct, f.base.as_str(), None)
            .unwrap(),
        b"{}"
    );
}

#[test]
fn oidc_rejects_algorithm_key_issuer_missing_nonce_and_untrusted_key_urls() {
    let jwt = sign(claims());
    for (field, value) in [
        ("kty", json!("EC")),
        ("kid", json!("other")),
        ("issuer", json!("https://evil.test")),
        ("use", json!("enc")),
        ("alg", json!("HS256")),
        ("n", json!("invalid")),
    ] {
        let mut k: serde_json::Value = serde_json::from_slice(&keys()).unwrap();
        k["keys"][0][field] = value;
        assert!(
            verify_identity(
                &jwt,
                k.to_string().as_bytes(),
                CLIENT,
                Some("nonce"),
                "access",
                now()
            )
            .is_err(),
            "{field}"
        );
    }
    for header in [
        json!({"alg":"none","kid":"fixture"}),
        json!({"alg":"HS256","kid":"fixture"}),
        json!({"alg":"RS256","kid":"fixture","crit":["jku"],"jku":"https://evil.test/keys"}),
    ] {
        let mut p: Vec<_> = jwt.split('.').map(str::to_owned).collect();
        p[0] = B64.encode(header.to_string());
        assert!(
            verify_identity(
                &p.join("."),
                &keys(),
                CLIENT,
                Some("nonce"),
                "access",
                now()
            )
            .is_err()
        );
    }
    let mut c = claims();
    c.as_object_mut().unwrap().remove("nonce");
    assert!(verify_identity(&sign(c), &keys(), CLIENT, Some("nonce"), "access", now()).is_err());
}

#[test]
fn graph_vault_namespace_cannot_access_legacy_credentials() {
    for key in [EMAIL, "", "__oreneta_graph"] {
        assert!(crate::secrets::graph_record_load(key).is_err());
        assert!(crate::secrets::graph_record_store(key, "{}").is_err());
        assert!(crate::secrets::graph_record_delete(key).is_err());
    }
}

#[test]
fn journal_precedes_secret_write_and_cleanup_preserves_account_on_failure() {
    let db = Arc::new(Mutex::new(crate::store::open_at(":memory:").unwrap()));
    let memory = Arc::new(Memory::default());
    let journal = Journalled {
        inner: memory.clone(),
        db: db.clone(),
    };
    assert!(!journal.registered(EMAIL).unwrap());
    memory.fail.store(true, Ordering::SeqCst);
    assert_eq!(journal.save(&record()), Err(Failure::Storage));
    assert!(journal.registered(EMAIL).unwrap());
    assert!(memory.load(EMAIL).unwrap().is_none());
    let manager = Manager::new(Fake::new(), journal);
    assert_eq!(manager.forget_account(EMAIL), Err(Failure::Storage));
    assert!(manager.vault.registered(EMAIL).unwrap());
    memory.fail.store(false, Ordering::SeqCst);
    manager.vault.save(&record()).unwrap();
    manager.forget_account(EMAIL).unwrap();
    assert!(!manager.vault.registered(EMAIL).unwrap());
    assert!(memory.load(EMAIL).unwrap().is_none());
    // Ordinary removal never calls an unavailable Graph keychain.
    memory.fail.store(true, Ordering::SeqCst);
    assert!(manager.forget_account("legacy@example.test").is_ok());
    // A broken journal must prevent the token write entirely.
    db.lock()
        .unwrap()
        .execute("DROP TABLE settings", [])
        .unwrap();
    memory.fail.store(false, Ordering::SeqCst);
    let saves = memory.saves.load(Ordering::SeqCst);
    assert_eq!(manager.vault.save(&record()), Err(Failure::Storage));
    assert_eq!(memory.saves.load(Ordering::SeqCst), saves);
}
