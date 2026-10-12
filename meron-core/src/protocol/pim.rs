use super::*;
use std::sync::Arc;

/// Calendar and address-book commands, answered by the same code as the
/// desktop's (`crate::pim`, ADR-0045) on the hosted Engine.
pub(crate) const MOBILE_PIM_METHODS: &[&str] = &[
    "calendar.list",
    "calendar.setEnabled",
    "calendar.events",
    "calendar.eventDetails",
    "calendar.create",
    "calendar.update",
    "calendar.delete",
    "people.list",
    "people.save",
    "people.delete",
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
            "calendar.setEnabled" => crate::pim::calendar::set_enabled(&engine, p),
            "calendar.events" => crate::pim::calendar::events(&engine, &emit, p),
            "calendar.eventDetails" => crate::pim::calendar::event_details(&engine, p).await,
            "calendar.create" => crate::pim::calendar::create(&engine, &emit, p).await,
            "calendar.update" => crate::pim::calendar::update(&engine, &emit, p).await,
            "calendar.delete" => crate::pim::calendar::delete(&engine, &emit, p).await,
            "people.list" => crate::pim::people::list(&engine, p),
            "people.save" => crate::pim::people::save(&engine, p).await,
            "people.delete" => crate::pim::people::delete(&engine, p).await,
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
