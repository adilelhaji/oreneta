//! Backend-only delegated Graph authorization. See docs/graph-authorization.md.
use super::{Client, Grant};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use url::Url;

const LOGIN: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const KEYS: &str = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
pub const SCOPES: &str =
    "openid email profile offline_access https://graph.microsoft.com/Mail.Read";
const TTL: i64 = 600;
const MAX_JSON: u64 = 128 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    InvalidRequest,
    Expired,
    Cancelled,
    Replayed,
    Denied,
    InvalidIdentity,
    DifferentAccount,
    ConsentRequired,
    Reauthenticate,
    Unavailable,
    Storage,
    InvalidResponse,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Graph authorization: {self:?}")
    }
}
impl std::error::Error for Failure {}
type Result<T> = std::result::Result<T, Failure>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Principal {
    pub tenant: String,
    pub object: String,
    pub email: String,
}
impl Principal {
    fn same_person(&self, other: &Self) -> bool {
        self.tenant == other.tenant && self.object == other.object
    }
}

/// Deliberately not Debug. Serialized only to the OS vault, never the UI.
#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    version: u32,
    pub account: String,
    pub principal: Principal,
    client_id: String,
    access_token: String,
    refresh_token: String,
    scopes: String,
    expires_at: i64,
}
impl Record {
    pub fn grant(&self) -> Result<Grant> {
        let grant = Grant::new(
            &self.account,
            &self.access_token,
            &self.scopes,
            self.expires_at,
        )
        .map_err(|_| Failure::InvalidResponse)?;
        grant.authorize(true).map_err(graph_failure)?;
        Ok(grant)
    }
    fn validate_stored(&self, account: &str) -> Result<()> {
        if self.version != 1
            || self.account != account
            || !valid_address(&self.account)
            || !guid(&self.principal.tenant)
            || !guid(&self.principal.object)
            || !guid(&self.client_id)
            || !valid_address(&self.principal.email)
            || self.refresh_token.is_empty()
            || self.refresh_token.len() > 32768
            || Grant::new(account, &self.access_token, &self.scopes, i64::MAX).is_err()
            || !has_read(&self.scopes)
        {
            return Err(Failure::Storage);
        }
        Ok(())
    }
}

pub trait Vault: Send + Sync {
    fn load(&self, account: &str) -> Result<Option<Record>>;
    fn save(&self, record: &Record) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
    fn registered(&self, account: &str) -> Result<bool> {
        Ok(self.load(account)?.is_some())
    }
}
pub struct Journalled<V: Vault> {
    inner: V,
    db: Arc<Mutex<rusqlite::Connection>>,
}
fn marker(account: &str) -> String {
    format!("graph.grant.{}", vault_key(account))
}
impl<V: Vault> Vault for Journalled<V> {
    fn load(&self, account: &str) -> Result<Option<Record>> {
        self.inner.load(account)
    }
    fn save(&self, record: &Record) -> Result<()> {
        crate::store::setting_set(
            &self.db.lock().unwrap(),
            &marker(&record.account),
            &serde_json::json!(true),
        )
        .map_err(|_| Failure::Storage)?;
        self.inner.save(record)
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.inner.delete(account)?;
        self.db
            .lock()
            .unwrap()
            .execute("DELETE FROM settings WHERE key = ?1", [marker(account)])
            .map_err(|_| Failure::Storage)?;
        Ok(())
    }
    fn registered(&self, account: &str) -> Result<bool> {
        // Any marker, including malformed values, requires secure cleanup.
        self.db
            .lock()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?1)",
                [marker(account)],
                |r| r.get(0),
            )
            .map_err(|_| Failure::Storage)
    }
}
pub struct Keychain;
fn vault_key(account: &str) -> String {
    let hash: String = Sha256::digest(account.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("__oreneta_graph_v1_{hash}")
}
impl Vault for Keychain {
    fn load(&self, account: &str) -> Result<Option<Record>> {
        crate::secrets::graph_record_load(&vault_key(account))
            .map_err(|_| Failure::Storage)?
            .map(|blob| {
                if blob.len() > MAX_JSON as usize {
                    return Err(Failure::Storage);
                }
                let record: Record = serde_json::from_str(&blob).map_err(|_| Failure::Storage)?;
                record.validate_stored(account)?;
                Ok(record)
            })
            .transpose()
    }
    fn save(&self, record: &Record) -> Result<()> {
        record.validate_stored(&record.account)?;
        let blob = serde_json::to_string(record).map_err(|_| Failure::Storage)?;
        crate::secrets::graph_record_store(&vault_key(&record.account), &blob)
            .map_err(|_| Failure::Storage)
    }
    fn delete(&self, account: &str) -> Result<()> {
        crate::secrets::graph_record_delete(&vault_key(account)).map_err(|_| Failure::Storage)
    }
}

#[derive(Clone)]
pub struct Flow {
    state: String,
    verifier: String,
    nonce: String,
    redirect: String,
    client_id: String,
    selected: Option<String>,
    deadline: i64,
    proxy: crate::proxy::ProxyChoice,
}
#[derive(Clone, Serialize)]
pub struct Begin {
    pub attempt: String,
    pub url: String,
}
#[derive(Clone, Serialize)]
pub struct Status {
    pub state: String,
    pub account: Option<String>,
    pub principal: Option<Principal>,
    pub error: Option<Failure>,
    pub mail_backend_ready: bool,
}
fn status(state: &str) -> Status {
    Status {
        state: state.into(),
        account: None,
        principal: None,
        error: None,
        mail_backend_ready: false,
    }
}
struct Pending {
    flow: Flow,
    status: Status,
}
pub trait Provider: Send + Sync {
    fn exchange(&self, flow: &Flow, code: &str) -> Result<Record>;
    fn refresh(&self, record: &Record, proxy: &crate::proxy::ProxyChoice) -> Result<Record>;
}

pub struct Manager<P: Provider, V: Vault> {
    provider: P,
    vault: V,
    pending: Mutex<HashMap<String, Pending>>,
    account_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}
pub type NativeManager = Manager<Microsoft, Journalled<Keychain>>;
impl NativeManager {
    pub fn for_store(db: Arc<Mutex<rusqlite::Connection>>) -> Self {
        Self::new(
            Microsoft,
            Journalled {
                inner: Keychain,
                db,
            },
        )
    }
}
impl<P: Provider, V: Vault> Manager<P, V> {
    pub fn new(provider: P, vault: V) -> Self {
        Self {
            provider,
            vault,
            pending: Mutex::new(HashMap::new()),
            account_locks: Mutex::new(HashMap::new()),
        }
    }
    fn account_lock(&self, account: &str) -> Arc<Mutex<()>> {
        self.account_locks
            .lock()
            .unwrap()
            .entry(account.into())
            .or_default()
            .clone()
    }
    pub fn begin(
        &self,
        selected: Option<String>,
        client_id: &str,
        redirect: &str,
        proxy: crate::proxy::ProxyChoice,
    ) -> Result<Begin> {
        if !guid(client_id) || selected.as_deref().is_some_and(|s| !valid_address(s)) {
            return Err(Failure::InvalidRequest);
        }
        let uri = Url::parse(redirect).map_err(|_| Failure::InvalidRequest)?;
        if uri.scheme() != "http"
            || uri.host_str() != Some("127.0.0.1")
            || uri.port().is_none()
            || uri.path() != "/"
            || uri.query().is_some()
            || uri.fragment().is_some()
            || !uri.username().is_empty()
            || uri.password().is_some()
        {
            return Err(Failure::InvalidRequest);
        }
        let flow = Flow {
            state: random()?,
            verifier: random()?,
            nonce: random()?,
            redirect: redirect.into(),
            client_id: client_id.into(),
            selected,
            deadline: now() + TTL,
            proxy,
        };
        let mut url = Url::parse(LOGIN).unwrap();
        url.query_pairs_mut().extend_pairs([
            ("client_id", client_id),
            ("response_type", "code"),
            ("response_mode", "query"),
            ("redirect_uri", redirect),
            ("scope", SCOPES),
            ("state", &flow.state),
            ("nonce", &flow.nonce),
            (
                "code_challenge",
                &B64.encode(Sha256::digest(flow.verifier.as_bytes())),
            ),
            ("code_challenge_method", "S256"),
            ("prompt", "select_account"),
        ]);
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| p.flow.deadline > now());
        if pending.len() >= 32 {
            return Err(Failure::Unavailable);
        }
        pending.retain(|_, p| p.flow.selected != flow.selected);
        let reply = Begin {
            attempt: flow.state.clone(),
            url: url.to_string(),
        };
        pending.insert(
            flow.state.clone(),
            Pending {
                flow,
                status: status("pending"),
            },
        );
        Ok(reply)
    }
    pub fn poll(&self, attempt: &str) -> Status {
        self.pending
            .lock()
            .unwrap()
            .get(attempt)
            .map(|p| {
                if p.flow.deadline <= now() {
                    status("expired")
                } else {
                    p.status.clone()
                }
            })
            .unwrap_or_else(|| status("cancelled"))
    }
    pub fn cancel(&self, attempt: &str) {
        self.pending.lock().unwrap().remove(attempt);
    }
    pub fn complete(
        &self,
        attempt: &str,
        returned_state: &str,
        code: &str,
        denied: bool,
    ) -> Result<Status> {
        let flow = {
            let mut pending = self.pending.lock().unwrap();
            let p = pending.get_mut(attempt).ok_or(Failure::Cancelled)?;
            if p.flow.state != returned_state {
                return Err(Failure::InvalidRequest);
            }
            if p.flow.deadline <= now() {
                return Err(Failure::Expired);
            }
            if p.status.state != "pending" {
                return Err(Failure::Replayed);
            }
            if denied {
                p.status.state = "failed".into();
                p.status.error = Some(Failure::Denied);
                return Err(Failure::Denied);
            }
            if code.is_empty() || code.len() > 32768 {
                return Err(Failure::InvalidRequest);
            }
            p.status.state = "exchanging".into();
            p.flow.clone()
        };
        let result = self.provider.exchange(&flow, code);
        let account = result
            .as_ref()
            .map(|r| r.account.clone())
            .unwrap_or_default();
        let account_lock = self.account_lock(&account);
        let _account_guard = account_lock.lock().unwrap();
        let mut pending = self.pending.lock().unwrap();
        let p = pending.get_mut(attempt).ok_or(Failure::Cancelled)?;
        if p.flow.deadline <= now() {
            return Err(Failure::Expired);
        }
        let result = result.and_then(|record| {
            record.validate_stored(&record.account)?;
            if let Some(selected) = &flow.selected {
                if &record.account != selected {
                    return Err(Failure::DifferentAccount);
                }
            }
            if let Some(previous) = self.vault.load(&record.account)? {
                if !previous.principal.same_person(&record.principal) {
                    return Err(Failure::DifferentAccount);
                }
            } else if !record.account.eq_ignore_ascii_case(&record.principal.email) {
                return Err(Failure::DifferentAccount);
            }
            self.vault.save(&record)?;
            Ok(record)
        });
        match result {
            Ok(record) => {
                p.status = Status {
                    state: "authorized".into(),
                    account: Some(record.account),
                    principal: Some(record.principal),
                    error: None,
                    mail_backend_ready: false,
                };
                Ok(p.status.clone())
            }
            Err(error) => {
                p.status.state = "failed".into();
                p.status.error = Some(error);
                Err(error)
            }
        }
    }
    pub fn record(&self, account: &str, proxy: &crate::proxy::ProxyChoice) -> Result<Record> {
        let lock = self.account_lock(account);
        let _guard = lock.lock().unwrap();
        let record = self.vault.load(account)?.ok_or(Failure::Reauthenticate)?;
        record.validate_stored(account)?;
        if record.expires_at > now() + 60 {
            return Ok(record);
        }
        let refreshed = self.provider.refresh(&record, proxy)?;
        if refreshed.account != record.account
            || !refreshed.principal.same_person(&record.principal)
            || refreshed.client_id != record.client_id
        {
            return Err(Failure::DifferentAccount);
        }
        refreshed.validate_stored(account)?;
        refreshed.grant()?;
        self.vault.save(&refreshed)?;
        Ok(refreshed)
    }
    pub fn disconnect(&self, account: &str) -> Result<()> {
        self.remove_grant(account, false)
    }
    pub fn forget_account(&self, account: &str) -> Result<()> {
        self.remove_grant(account, true)
    }
    fn remove_grant(&self, account: &str, only_registered: bool) -> Result<()> {
        let lock = self.account_lock(account);
        let _guard = lock.lock().unwrap();
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| {
            p.flow.selected.is_some()
                && p.flow.selected.as_deref() != Some(account)
                && p.status.account.as_deref() != Some(account)
        });
        if !only_registered || self.vault.registered(account)? {
            self.vault.delete(account)?;
        }
        Ok(())
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn random() -> Result<String> {
    let mut bytes = [0; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Failure::Unavailable)?;
    Ok(B64.encode(bytes))
}
fn guid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|u| u.to_string() == s && !u.is_nil())
}
fn valid_address(s: &str) -> bool {
    s.len() <= 320
        && s.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && !domain.is_empty() && !domain.contains('@')
        })
        && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}
fn graph_failure(error: super::Error) -> Failure {
    match error.kind {
        super::ErrorKind::Reauthenticate => Failure::Reauthenticate,
        super::ErrorKind::ConsentRequired => Failure::ConsentRequired,
        super::ErrorKind::AccessDenied => Failure::Denied,
        super::ErrorKind::InvalidResponse => Failure::InvalidResponse,
        _ => Failure::Unavailable,
    }
}
fn has_read(scope: &str) -> bool {
    scope.split_ascii_whitespace().any(|s| {
        matches!(
            s.strip_prefix("https://graph.microsoft.com/").unwrap_or(s),
            "Mail.Read" | "Mail.ReadWrite"
        )
    })
}

pub struct Microsoft;
#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    scope: String,
    expires_in: i64,
    token_type: String,
    id_token: Option<String>,
}
impl Microsoft {
    fn http(
        &self,
        proxy: &crate::proxy::ProxyChoice,
        url: &str,
        form: Option<&[(&str, &str)]>,
    ) -> Result<Vec<u8>> {
        let agent = match proxy.resolve() {
            Some(p) => crate::proxy::agent_for(Some(&p)).map_err(|_| Failure::Unavailable)?,
            None => ureq::Agent::new_with_config(ureq::Agent::config_builder().proxy(None).build()),
        };
        let mut response = if let Some(form) = form {
            agent
                .post(url)
                .config()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(20)))
                .build()
                .send_form(form.iter().copied())
                .map_err(|_| Failure::Unavailable)?
        } else {
            agent
                .get(url)
                .config()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(20)))
                .build()
                .call()
                .map_err(|_| Failure::Unavailable)?
        };
        let status = response.status().as_u16();
        let bytes = response
            .body_mut()
            .with_config()
            .limit(MAX_JSON)
            .read_to_vec()
            .map_err(|_| Failure::InvalidResponse)?;
        if status != 200 {
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
            return Err(match body["error"].as_str() {
                Some("invalid_grant" | "interaction_required") => Failure::Reauthenticate,
                Some("access_denied" | "consent_required") => Failure::Denied,
                _ => Failure::Unavailable,
            });
        }
        Ok(bytes)
    }
    fn tokens(&self, proxy: &crate::proxy::ProxyChoice, form: &[(&str, &str)]) -> Result<Tokens> {
        let bytes = self.http(proxy, TOKEN, Some(form))?;
        Tokens::parse(&bytes)
    }
    fn identity(
        &self,
        jwt: &str,
        client: &str,
        nonce: Option<&str>,
        access: &str,
        proxy: &crate::proxy::ProxyChoice,
    ) -> Result<Principal> {
        let keys = self.http(proxy, KEYS, None)?;
        verify_identity(jwt, &keys, client, nonce, access, now())
    }
}
impl Tokens {
    fn parse(bytes: &[u8]) -> Result<Self> {
        let tokens: Tokens = serde_json::from_slice(bytes).map_err(|_| Failure::InvalidResponse)?;
        if tokens.token_type != "Bearer"
            || tokens.expires_in <= 0
            || now().checked_add(tokens.expires_in).is_none()
            || tokens.access_token.is_empty()
            || tokens.access_token.len() > 32768
        {
            return Err(Failure::InvalidResponse);
        }
        if !has_read(&tokens.scope) {
            return Err(Failure::ConsentRequired);
        }
        Ok(tokens)
    }
    fn refreshed(self, record: &Record) -> Result<Record> {
        let updated = Record {
            access_token: self.access_token,
            refresh_token: self
                .refresh_token
                .unwrap_or_else(|| record.refresh_token.clone()),
            expires_at: now() + self.expires_in,
            scopes: self.scope,
            ..record.clone()
        };
        updated.validate_stored(&record.account)?;
        Ok(updated)
    }
}
impl Provider for Microsoft {
    fn exchange(&self, flow: &Flow, code: &str) -> Result<Record> {
        let tokens = self.tokens(
            &flow.proxy,
            &[
                ("grant_type", "authorization_code"),
                ("client_id", &flow.client_id),
                ("code", code),
                ("redirect_uri", &flow.redirect),
                ("code_verifier", &flow.verifier),
                ("scope", SCOPES),
            ],
        )?;
        let principal = self.identity(
            tokens.id_token.as_deref().ok_or(Failure::InvalidIdentity)?,
            &flow.client_id,
            Some(&flow.nonce),
            &tokens.access_token,
            &flow.proxy,
        )?;
        let account = flow
            .selected
            .clone()
            .unwrap_or_else(|| principal.email.to_lowercase());
        let record = Record {
            version: 1,
            account,
            principal,
            client_id: flow.client_id.clone(),
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token.ok_or(Failure::InvalidResponse)?,
            scopes: tokens.scope,
            expires_at: now() + tokens.expires_in,
        };
        record.validate_stored(&record.account)?;
        // Validates this is a usable Graph-resource mail grant, without writes.
        Client::new(record.grant()?, flow.proxy.clone())
            .folders(None, None)
            .map_err(graph_failure)?;
        Ok(record)
    }
    fn refresh(&self, record: &Record, proxy: &crate::proxy::ProxyChoice) -> Result<Record> {
        let tokens = self.tokens(
            proxy,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", &record.client_id),
                ("refresh_token", &record.refresh_token),
                ("scope", SCOPES),
            ],
        )?;
        if let Some(jwt) = &tokens.id_token {
            let identity =
                self.identity(jwt, &record.client_id, None, &tokens.access_token, proxy)?;
            if !identity.same_person(&record.principal) {
                return Err(Failure::DifferentAccount);
            }
        }
        tokens.refreshed(record)
    }
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    aud: String,
    azp: Option<String>,
    exp: i64,
    nbf: i64,
    iat: i64,
    tid: String,
    oid: String,
    nonce: Option<String>,
    preferred_username: Option<String>,
    email: Option<String>,
    at_hash: Option<String>,
}
#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: String,
    crit: Option<serde_json::Value>,
}
#[derive(Deserialize)]
struct Keys {
    keys: Vec<Key>,
}
#[derive(Deserialize)]
struct Key {
    kid: String,
    kty: String,
    n: String,
    e: String,
    issuer: String,
    #[serde(rename = "use")]
    usage: Option<String>,
    alg: Option<String>,
}

fn verify_identity(
    jwt: &str,
    jwks: &[u8],
    client: &str,
    nonce: Option<&str>,
    access: &str,
    now: i64,
) -> Result<Principal> {
    let invalid = || Failure::InvalidIdentity;
    if jwt.len() > 32768 || jwks.len() > MAX_JSON as usize {
        return Err(invalid());
    }
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() != 3 {
        return Err(invalid());
    }
    let header: Header = serde_json::from_slice(&B64.decode(parts[0]).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    let claims: Claims = serde_json::from_slice(&B64.decode(parts[1]).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    if header.alg != "RS256"
        || header.crit.is_some()
        || !guid(&claims.tid)
        || !guid(&claims.oid)
        || claims.aud != client
        || claims.sub.is_empty()
        || claims.azp.as_deref().is_some_and(|azp| azp != client)
        || claims.exp <= now
        || claims.exp <= claims.iat
        || claims.exp <= claims.nbf
        || claims.nbf > now + 60
        || claims.iat > now + 60
        || claims.iss != format!("https://login.microsoftonline.com/{}/v2.0", claims.tid)
        || nonce.is_some_and(|n| claims.nonce.as_deref() != Some(n))
    {
        return Err(invalid());
    }
    let keys: Keys = serde_json::from_slice(jwks).map_err(|_| invalid())?;
    let key = keys
        .keys
        .iter()
        .find(|key| {
            key.kid == header.kid
                && key.kty == "RSA"
                && key.usage.as_deref().is_none_or(|u| u == "sig")
                && key.alg.as_deref().is_none_or(|a| a == "RS256")
                && key.issuer.replace("{tenantid}", &claims.tid) == claims.iss
        })
        .ok_or_else(invalid)?;
    let n = B64.decode(&key.n).map_err(|_| invalid())?;
    let e = B64.decode(&key.e).map_err(|_| invalid())?;
    let sig = B64.decode(parts[2]).map_err(|_| invalid())?;
    signature::RsaPublicKeyComponents { n: &n, e: &e }
        .verify(
            &signature::RSA_PKCS1_2048_8192_SHA256,
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &sig,
        )
        .map_err(|_| invalid())?;
    if claims
        .at_hash
        .is_some_and(|hash| hash != B64.encode(&Sha256::digest(access.as_bytes())[..16]))
    {
        return Err(invalid());
    }
    let email = claims
        .email
        .or(claims.preferred_username)
        .ok_or_else(invalid)?;
    if !valid_address(&email) {
        return Err(invalid());
    }
    Ok(Principal {
        tenant: claims.tid,
        object: claims.oid,
        email,
    })
}

#[cfg(test)]
mod tests;
