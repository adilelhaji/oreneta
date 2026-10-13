use super::*;
use std::sync::Arc;

/// Calendar and address-book commands, answered by the same code as the
/// desktop's (`crate::pim`, ADR-0045) on the hosted Engine.
pub(crate) const MOBILE_PIM_METHODS: &[&str] = &[
    "calendar.list",
    "calendar.createLocal",
    "calendar.setEnabled",
    "calendar.events",
    "calendar.eventDetails",
    "calendar.create",
    "calendar.update",
    "calendar.delete",
    "people.list",
    "people.save",
    "people.delete",
    "pim.refresh",
    "google.contacts.sync",
    "carddav.sync",
    "carddav.list",
];

/// Runs one of [`MOBILE_PIM_METHODS`] against the Engine for `data_dir`. A
/// refresh it starts (`calendar.events`, and the window a write lands in)
/// keeps running on the Engine's runtime after the answer, and reports
/// `calendar.synced` / `calendar.syncError` over the event channel, as the
/// desktop does on stdout.
pub(crate) fn run_mobile_pim_command(data_dir: &str, req: &Request) -> Result<Value, String> {
    let engine = crate::ffi::engine_for(data_dir)?;
    let emit = mobile_pim_emit();
    let p = &req.params;
    crate::ffi::engine_block_on(async {
        // The desktop's guard: writes to a Graph account's calendar are
        // refused there, and so here.
        crate::graph::mail::guard_command(&engine.db.lock().unwrap(), &req.method, p)?;
        match req.method.as_str() {
            "calendar.list" => crate::pim::calendar::list(&engine, p),
            "calendar.createLocal" => crate::pim::calendar::create_local(&engine, p),
            "calendar.setEnabled" => crate::pim::calendar::set_enabled(&engine, p),
            "calendar.events" => crate::pim::calendar::events(&engine, &emit, p),
            "calendar.eventDetails" => crate::pim::calendar::event_details(&engine, p).await,
            "calendar.create" => crate::pim::calendar::create(&engine, &emit, p).await,
            "calendar.update" => crate::pim::calendar::update(&engine, &emit, p).await,
            "calendar.delete" => crate::pim::calendar::delete(&engine, &emit, p).await,
            "people.list" => crate::pim::people::list(&engine, p),
            "people.save" => crate::pim::people::save(&engine, p).await,
            "people.delete" => crate::pim::people::delete(&engine, p).await,
            "pim.refresh" => Ok(mobile_pim_refresh(&engine, &emit, p).await),
            "google.contacts.sync" => crate::pim::people::google_sync(&engine, p).await,
            "carddav.sync" => crate::pim::people::source_sync(&engine, p).await,
            "carddav.list" => crate::pim::people::sources(&engine),
            method => anyhow::bail!("unknown method: {method}"),
        }
    })
}

/// Background work's events, handed to the platform callback.
fn mobile_pim_emit() -> crate::pim::Emit {
    Arc::new(|name, detail| {
        let _ = crate::ffi::emit_event(name, detail);
        Box::pin(async {})
    })
}

/// `pim.refresh`: the phone's periodic calendar and address-book refresh, and
/// the reminders due now (`crate::pim::refresh`). The foreground calls it on a
/// minute tick and the background refresh after mail; both post the
/// `reminders` it answers as local notifications. `sync: false` only looks
/// for reminders, for when the person has turned automatic checking off;
/// `only: "books"` / `"calendars"` reads one of the two; `force` reads
/// even what is not yet due.
async fn mobile_pim_refresh(engine: &Arc<crate::engine::Engine>, emit: &crate::pim::Emit, p: &Value) -> Value {
    let accounts = crate::store::load_accounts(&engine.db.lock().unwrap()).unwrap_or_default();
    let now = p.get("now").and_then(Value::as_i64).unwrap_or_else(crate::store::now_unix);
    let only = p.get("only").and_then(Value::as_str).unwrap_or_default();
    let options = crate::pim::refresh::Options {
        sync: p.get("sync").and_then(Value::as_bool).unwrap_or(true),
        force: p.get("force").and_then(Value::as_bool).unwrap_or(false),
        calendars: only != "books",
        books: only != "calendars",
    };
    crate::pim::refresh::run(engine, emit, &accounts, now, options).await
}
