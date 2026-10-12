//! Calendar and address-book commands both hosts answer (ADR-0045).
//!
//! The desktop sidecar's `dispatch` and the mobile protocol call the same
//! functions here, so a phone reads and writes calendars and people through
//! the code the desktop already uses rather than a second copy of it. Each
//! command takes the [`Engine`](crate::engine::Engine) and its request's
//! params, and answers the JSON the host forwards unchanged.

pub mod calendar;
pub mod people;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use serde_json::Value;

/// Where background work says it finished: the desktop sidecar writes the
/// event to stdout for the bridge, the mobile host hands it to the platform's
/// event callback. Either way it is `{"event": name, "detail": detail}`.
pub type Emit = Arc<dyn Fn(&'static str, Value) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// How long a background refresh waits before its one retry.
const RETRY_DELAY: Duration = if cfg!(test) { Duration::ZERO } else { Duration::from_secs(2) };

fn req_str(params: &Value, key: &str) -> anyhow::Result<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("missing string param: {key}"))
}

fn req_i64(params: &Value, key: &str) -> anyhow::Result<i64> {
    params
        .get(key)
        .and_then(Value::as_i64)
        .with_context(|| format!("missing number param: {key}"))
}

fn req_u32(params: &Value, key: &str) -> anyhow::Result<u32> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .ok_or_else(|| anyhow::anyhow!("missing number param: {key}"))
}
