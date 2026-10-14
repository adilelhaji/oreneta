//! The calendar commands: `calendar.list`, `calendar.setEnabled`,
//! `calendar.events`, `calendar.eventDetails`, `calendar.create`,
//! `calendar.update` and `calendar.delete`, and the background refresh the
//! reads and writes start.

use std::sync::Arc;

use anyhow::{Context as _, Result};
use serde_json::{json, Value};

use super::{req_i64, req_str, Emit};
use crate::calendar;
use crate::engine::{retry_background_sync_after, BackgroundSyncCancelled, Engine};
use crate::store::now_unix;


/// The calendars of an account, from the cache.
pub fn list(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let calendars = calendar::get_calendars(&engine.db.lock().unwrap(), &account)?;
    Ok(json!({ "calendars": serde_json::to_value(calendars)? }))
}

/// Adds a calendar kept only on this device, under an account.
pub fn create_local(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let name = req_str(p, "name")?;
    if name.trim().is_empty() {
        anyhow::bail!("a calendar needs a name");
    }
    let id = format!("local:{}", uuid::Uuid::new_v4());
    calendar::upsert_calendars(
        &engine.db.lock().unwrap(),
        &account,
        &[calendar::Calendar {
            id: id.clone(),
            name,
            kind: calendar::CalendarKind::Local,
            enabled: true,
            ..Default::default()
        }],
    )?;
    Ok(json!({ "id": id }))
}

/// Shows or hides one calendar. Hiding never forgets it.
pub fn set_enabled(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let id = req_str(p, "calendar")?;
    let enabled = p
        .get("enabled")
        .and_then(Value::as_bool)
        .context("missing bool param: enabled")?;
    calendar::set_calendar_enabled(&engine.db.lock().unwrap(), &account, &id, enabled)?;
    Ok(json!({ "ok": true }))
}

/// Answers from the cache and refreshes behind the request, the same
/// contract `folders.list` and `messages.recent` give: a view renders at once
/// and settles when the server answers.
pub fn events(engine: &Arc<Engine>, emit: &Emit, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let from = req_i64(p, "from")?;
    let to = req_i64(p, "to")?;
    if to <= from {
        anyhow::bail!("calendar window ends before it starts");
    }
    let events = calendar::events_in_window(
        &engine.db.lock().unwrap(),
        &account,
        (from, to),
    )?;
    if p.get("refresh").and_then(Value::as_bool).unwrap_or(true) {
        spawn_sync(engine.clone(), emit.clone(), account, from, to);
    }
    Ok(json!({ "events": serde_json::to_value(events)? }))
}

/// What a cached occurrence cannot carry: who is on the event and its notes.
/// Exchange's window query returns neither, so they are fetched when a
/// reader opens one.
pub async fn event_details(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let calendar_id = p.get("calendar").and_then(Value::as_str).unwrap_or_default();
    let event_id = req_str(p, "event")?;
    let change_key = p.get("change_key").and_then(Value::as_str).filter(|k| !k.is_empty());
    let (attendees, description) = calendar::route::event_details(
        &engine,
        &account,
        calendar_id,
        &event_id,
        change_key,
    )
    .await?;
    Ok(json!({
        "attendees": serde_json::to_value(attendees)?,
        "description": description,
    }))
}

/// Creates an event: in the local store for a local calendar, on the server
/// for any other, and then refreshes the window it lands in.
pub async fn create(engine: &Arc<Engine>, emit: &Emit, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let event: calendar::Event = serde_json::from_value(
        p.get("event").cloned().context("missing param: event")?,
    )
    .context("event")?;
    // Local and CalDAV calendars have nobody to make a meeting with
    // (#109); Exchange is refused where it is routed.
    if event.add_meeting.as_deref().is_some_and(|m| m != "none")
        && (local_calendar_write(&engine, &account, &event.calendar_id)?.is_some()
            || caldav_write(&engine, &account, &event.calendar_id)?.is_some())
    {
        anyhow::bail!("online meetings can be added here only to Google calendars");
    }
    if event.end < event.start {
        anyhow::bail!("an event cannot end before it starts");
    }
    if let Some(local) = local_calendar_write(&engine, &account, &event.calendar_id)? {
        // A local calendar keeps single events: there is no server to
        // expand a rule, and storing one unexpanded would show it once.
        if event.recurrence.is_some() {
            anyhow::bail!(
                "a local calendar keeps single events; a repeating event needs an account calendar"
            );
        }
        let created = calendar::Event {
            id: format!("local:{}", uuid::Uuid::new_v4()),
            calendar_id: local.id,
            // Its SEQUENCE, which a new event starts at.
            change_key: Some("0".into()),
            is_recurring: false,
            series_id: None,
            ..event
        };
        calendar::put_local_event(&engine.db.lock().unwrap(), &account, &created)?;
        return Ok(json!({ "event": serde_json::to_value(created)? }));
    }
    if let Some((target, transport)) = caldav_write(&engine, &account, &event.calendar_id)? {
        let wanted = event.clone();
        let url = target.id.clone();
        let (uid, change) = tokio::task::spawn_blocking(move || {
            calendar::caldav::create(&transport, &url, &wanted, now_unix())
        })
        .await??;
        let calendar::caldav::Change::Saved { href, etag } = change else {
            anyhow::bail!("the server already holds an event at that address; nothing was saved");
        };
        calendar::caldav::remember(
            &engine.db.lock().unwrap(),
            &account,
            &target.id,
            &[calendar::caldav::Located { uid: uid.clone(), href, etag: etag.unwrap_or_default() }],
        )?;
        spawn_sync(engine.clone(), emit.clone(), account, event.start, event.end.max(event.start + 1));
        let created = calendar::Event { id: format!("{uid}@{}", event.start), ..event };
        return Ok(json!({ "event": serde_json::to_value(created)? }));
    }
    // Telling the people on an event is never assumed: the caller says
    // so only after the reader has confirmed it.
    let notify = p.get("notify").and_then(Value::as_bool).unwrap_or(false);
    let created = calendar::route::create_event(&engine, &account, &event, notify).await?;
    spawn_sync(
        engine.clone(),
        emit.clone(),
        account,
        created.start,
        created.end.max(created.start + 1),
    );
    Ok(json!({ "event": serde_json::to_value(created)? }))
}

/// Saves a changed event, one occurrence or (`scope: "series"`) the whole
/// series, checked against the version it was read at.
pub async fn update(engine: &Arc<Engine>, emit: &Emit, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let event: calendar::Event = serde_json::from_value(
        p.get("event").cloned().context("missing param: event")?,
    )
    .context("event")?;
    // Local and CalDAV calendars have nobody to make a meeting with
    // (#109); Exchange is refused where it is routed.
    if event.add_meeting.as_deref().is_some_and(|m| m != "none")
        && (local_calendar_write(&engine, &account, &event.calendar_id)?.is_some()
            || caldav_write(&engine, &account, &event.calendar_id)?.is_some())
    {
        anyhow::bail!("online meetings can be added here only to Google calendars");
    }
    if event.end < event.start {
        anyhow::bail!("an event cannot end before it starts");
    }
    // Which of the two questions an edit answers: this day, or every
    // day the series falls on. Absent means this one, which is what a
    // caller that has never heard of series should get.
    let whole_series = p
        .get("scope")
        .and_then(Value::as_str)
        .is_some_and(|scope| scope == "series");
    if local_calendar_write(&engine, &account, &event.calendar_id)?.is_some() {
        if event.recurrence.is_some() {
            anyhow::bail!(
                "a local calendar keeps single events; a repeating event needs an account calendar"
            );
        }
        // Each save is a new version of the event: its SEQUENCE, kept
        // in the change key, goes up from what is stored rather than
        // from what the editor opened with, so a notice sent after
        // this save always supersedes the one before.
        let db = engine.db.lock().unwrap();
        let stored = calendar::event_of(&db, &account, &event.calendar_id, &event.id)?;
        let sequence = stored.as_ref().map(|kept| calendar::local_sequence(kept) + 1).unwrap_or(0);
        let saved = calendar::Event { change_key: Some(sequence.to_string()), ..event };
        calendar::put_local_event(&db, &account, &saved)?;
        return Ok(json!({ "ok": true }));
    }
    if let Some((target, transport)) = caldav_write(&engine, &account, &event.calendar_id)? {
        let uid = calendar::caldav::uid_of(&event.id);
        let located = calendar::caldav::locate(&engine.db.lock().unwrap(), &account, &target.id, &uid)?
            .context("this event's place on the server is not known yet; refresh the calendar and try again")?;
        let seen = event.change_key.clone().unwrap_or_default();
        let wanted = event.clone();
        let url = target.id.clone();
        // The attendees the editor took out. Anyone else on the
        // server's copy stays, including people the editor never
        // showed.
        let removed: Vec<String> = p
            .get("removed_attendees")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let change = tokio::task::spawn_blocking(move || {
            calendar::caldav::update(&transport, &url, &located.href, &seen, &wanted, whole_series, &removed, now_unix())
        })
        .await??;
        spawn_sync(engine.clone(), emit.clone(), account.clone(), event.start, event.end.max(event.start + 1));
        match change {
            calendar::caldav::Change::Saved { href, etag } => {
                calendar::caldav::remember(
                    &engine.db.lock().unwrap(),
                    &account,
                    &target.id,
                    &[calendar::caldav::Located { uid, href, etag: etag.unwrap_or_default() }],
                )?;
                return Ok(json!({ "ok": true }));
            }
            calendar::caldav::Change::Conflict => anyhow::bail!(CALDAV_CONFLICT),
        }
    }
    let notify = p.get("notify").and_then(Value::as_bool).unwrap_or(false);
    let version =
        calendar::route::update_event(&engine, &account, &event, whole_series, notify)
            .await?;
    if let (Some(version), false) = (version, whole_series) {
        calendar::set_event_change_key(&engine.db.lock().unwrap(), &account, &event.id, &version)?;
    }
    spawn_sync(
        engine.clone(),
        emit.clone(),
        account,
        event.start,
        event.end.max(event.start + 1),
    );
    Ok(json!({ "ok": true }))
}

/// Deletes an occurrence, or (`scope: "series"`) the series it belongs to.
pub async fn delete(engine: &Arc<Engine>, emit: &Emit, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let id = req_str(p, "event")?;
    let change_key = p.get("change_key").and_then(Value::as_str);
    // Exchange addresses an event by its own id alone; Google needs
    // the calendar holding it, so it is taken from the cached row the
    // agenda is showing.
    let calendar_id = p
        .get("calendar")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    let whole_series = p
        .get("scope")
        .and_then(Value::as_str)
        .is_some_and(|scope| scope == "series");
    let series_id = p.get("series").and_then(Value::as_str);
    if local_calendar_write(&engine, &account, &calendar_id)?.is_some() {
        calendar::forget_event(&engine.db.lock().unwrap(), &account, &id)?;
        return Ok(json!({ "ok": true }));
    }
    if let Some((target, transport)) = caldav_write(&engine, &account, &calendar_id)? {
        let uid = calendar::caldav::uid_of(&id);
        let (located, all_day) = {
            let db = engine.db.lock().unwrap();
            let located = calendar::caldav::locate(&db, &account, &target.id, &uid)?;
            let all_day: bool = db
                .query_row(
                    "SELECT all_day FROM calendar_events WHERE account = ?1 AND calendar_id = ?2 AND event_id = ?3",
                    rusqlite::params![account, target.id, id],
                    |row| row.get::<_, i64>(0),
                )
                .map(|v| v != 0)
                .unwrap_or(false);
            (located, all_day)
        };
        let located = located.context("this event's place on the server is not known yet; refresh the calendar and try again")?;
        let seen = change_key.map(str::to_string).unwrap_or_else(|| located.etag.clone());
        let occurrence_only = !whole_series && series_id.is_some();
        let (url, href, event_id) = (target.id.clone(), located.href.clone(), id.clone());
        let change = tokio::task::spawn_blocking(move || {
            calendar::caldav::delete(&transport, &url, &href, &seen, &event_id, all_day, occurrence_only)
        })
        .await??;
        if change == calendar::caldav::Change::Conflict {
            let now = now_unix();
            spawn_sync(engine.clone(), emit.clone(), account, now - 86_400 * 31, now + 86_400 * 366);
            anyhow::bail!(CALDAV_CONFLICT);
        }
        let db = engine.db.lock().unwrap();
        if occurrence_only {
            calendar::forget_event(&db, &account, &id)?;
        } else {
            calendar::forget_series(&db, &account, &uid)?;
            calendar::forget_event(&db, &account, &id)?;
            calendar::caldav::forget(&db, &account, &target.id, &uid)?;
        }
        return Ok(json!({ "ok": true }));
    }
    calendar::route::delete_event(
        &engine,
        &account,
        &calendar_id,
        &id,
        change_key,
        series_id,
        whole_series,
        p.get("notify").and_then(Value::as_bool).unwrap_or(false),
    )
    .await?;
    // Drop the cached rows now: the agenda should not keep showing what
    // the server has already accepted the deletion of. A series takes
    // all of its occurrences with it.
    {
        let db = engine.db.lock().unwrap();
        match (whole_series, series_id) {
            (true, Some(series)) => {
                calendar::forget_series(&db, &account, series)?;
            }
            _ => calendar::forget_event(&db, &account, &id)?,
        }
    }
    Ok(json!({ "ok": true }))
}

/// The local calendar a write is addressed to, or None when it belongs to the
/// account's server. A subscribed calendar is refused: it belongs to whoever
/// publishes it. Local calendars used to be offered in the editor and then
/// sent to the account's server, which has never heard of them, so saving an
/// event there always failed.
pub fn local_calendar_write(
    engine: &Engine,
    account: &str,
    calendar_id: &str,
) -> Result<Option<calendar::Calendar>> {
    let found = calendar::calendar_of(&engine.db.lock().unwrap(), account, calendar_id)?;
    match found {
        Some(calendar) if calendar.kind == calendar::CalendarKind::Local => Ok(Some(calendar)),
        Some(calendar) if calendar.kind == calendar::CalendarKind::Subscribed => {
            anyhow::bail!("{} is a subscribed calendar and cannot be changed here", calendar.name)
        }
        _ => Ok(None),
    }
}

/// A CalDAV calendar of an account, and a transport signed in to it.
pub fn caldav_target(
    engine: &Engine,
    account: &str,
    calendar_id: &str,
) -> Result<(calendar::Calendar, crate::carddav::http::UreqTransport)> {
    let (found, sign_in, proxy) = {
        let db = engine.db.lock().unwrap();
        (
            calendar::calendar_of(&db, account, calendar_id)?,
            calendar::caldav::sign_in(&db, account, calendar_id)?,
            crate::store::account_proxy(&db, account)?,
        )
    };
    let (Some(found), Some((_, username))) = (found, sign_in) else {
        anyhow::bail!("that calendar is no longer here");
    };
    let password = crate::secrets::load(&calendar::caldav::secret_key(account, calendar_id))?.password;
    Ok((found, crate::carddav::http::UreqTransport { username, password, proxy }))
}

/// The CalDAV calendar an edit is for, when it is one, refusing a read-only
/// one before anything is sent.
pub fn caldav_write(
    engine: &Engine,
    account: &str,
    calendar_id: &str,
) -> Result<Option<(calendar::Calendar, crate::carddav::http::UreqTransport)>> {
    let is_caldav = calendar::calendar_of(&engine.db.lock().unwrap(), account, calendar_id)?
        .is_some_and(|found| found.kind == calendar::CalendarKind::CalDav);
    if !is_caldav {
        return Ok(None);
    }
    let (found, transport) = caldav_target(engine, account, calendar_id)?;
    if found.read_only {
        anyhow::bail!("{} is read-only on its server", found.name);
    }
    Ok(Some((found, transport)))
}

/// The answer to a write the server refused because its copy changed.
pub const CALDAV_CONFLICT: &str =
    "this event was changed or removed on the server since it was opened; nothing was saved, and the calendar is being refreshed";

/// Refreshes one window of an account's calendars behind the request that
/// asked for it, then says so through `emit`: `calendar.synced` when the
/// cache holds what the server answered, `calendar.syncError` when it could
/// not. One window is fetched at a time per account; asking again while it
/// runs does nothing.
pub fn spawn_sync(engine: Arc<Engine>, emit: Emit, account: String, from: i64, to: i64) {
    let Some(key) = claim_window(&engine, &account, from, to) else {
        return;
    };
    tokio::spawn(async move {
        run_claimed(&engine, &emit, &account, from, to, key).await;
    });
}

/// How a window refresh ended, for a caller that waits for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncOutcome {
    /// Not run: the account is paused, or the same window is already being
    /// fetched.
    Skipped,
    Synced,
    /// The account was paused while it waited to retry.
    Cancelled,
    /// What `calendar.syncError` said.
    Failed(String),
}

/// The same refresh as [`spawn_sync`], awaited: the periodic refresh
/// ([`super::refresh`]) needs to know how it went before it answers. The
/// events it reports are the same.
pub async fn sync_now(engine: &Arc<Engine>, emit: &Emit, account: &str, from: i64, to: i64) -> SyncOutcome {
    let Some(key) = claim_window(engine, account, from, to) else {
        return SyncOutcome::Skipped;
    };
    run_claimed(engine, emit, account, from, to, key).await
}

/// Marks a window as being fetched, or says it should not be: the account is
/// paused, or somebody is already at it.
fn claim_window(engine: &Arc<Engine>, account: &str, from: i64, to: i64) -> Option<String> {
    if engine.is_paused(account) {
        return None;
    }
    let key = format!("calendar:{account}:{from}:{to}");
    engine.syncing.lock().unwrap().insert(key.clone()).then_some(key)
}

async fn run_claimed(engine: &Arc<Engine>, emit: &Emit, account: &str, from: i64, to: i64, key: String) -> SyncOutcome {
    let result = retry_background_sync_after(
        &format!("calendar sync for {account}"),
        super::RETRY_DELAY,
        || !engine.is_paused(account),
        || sync_window(engine, account, from, to),
    )
    .await;
    engine.syncing.lock().unwrap().remove(&key);
    match result {
        Ok(_) => {
            emit("calendar.synced", json!({ "account": account, "from": from, "to": to })).await;
            SyncOutcome::Synced
        }
        Err(e) if e.is::<BackgroundSyncCancelled>() => SyncOutcome::Cancelled,
        Err(e) => {
            let message = format!("calendar sync: {e:#}");
            emit("calendar.syncError", json!({ "account": account, "message": message })).await;
            SyncOutcome::Failed(message)
        }
    }
}

/// Pulls the calendar list, then one window of occurrences per enabled
/// calendar.
///
/// A calendar the user hid is not fetched at all: the point of hiding one is
/// not to pay for it.
async fn sync_window(
    engine: &Arc<Engine>,
    account: &str,
    from: i64,
    to: i64,
) -> Result<()> {
    let calendars = calendar::route::list_calendars(engine, account).await?;
    {
        let db = engine.db.lock().unwrap();
        // Only the account's own calendars are refreshed from the server;
        // local and subscribed ones are not its to report, and upserting the
        // server's answer over them would drop them.
        calendar::replace_account_calendars(&db, account, &calendars)?;
    }
    let wanted: Vec<calendar::Calendar> = {
        let db = engine.db.lock().unwrap();
        calendar::get_calendars(&db, account)?
            .into_iter()
            .filter(|calendar| calendar.enabled)
            .collect()
    };

    for calendar in wanted {
        match calendar.kind {
            // Nothing to fetch: its events only ever came from here.
            calendar::CalendarKind::Local => continue,
            calendar::CalendarKind::Subscribed => {
                let Some(url) = calendar.url.clone() else {
                    continue;
                };
                let id = calendar.id.clone();
                // One subscription that cannot be fetched or read is that
                // calendar's problem: it keeps the events it last had, and the
                // calendars after it are still refreshed. Returning the error
                // here stopped the whole account's sync at the first one.
                let fetched = match tokio::task::spawn_blocking(move || {
                    calendar::subscription::fetch(&url)
                })
                .await
                {
                    Ok(Ok(body)) => calendar::subscription::parse_window(&body, &id, from, to),
                    Ok(Err(err)) => Err(err),
                    Err(err) => Err(err.into()),
                };
                let (events, skipped) = match fetched {
                    Ok(parsed) => parsed,
                    Err(err) => {
                        crate::mlog!(
                            crate::log::Level::Warn,
                            "calendar",
                            "{id}: subscription not refreshed: {err:#}"
                        );
                        continue;
                    }
                };
                if skipped > 0 {
                    crate::mlog!(
                        crate::log::Level::Warn,
                        "calendar",
                        "{id}: {skipped} entr(ies) in the published file could not be read"
                    );
                }
                let db = engine.db.lock().unwrap();
                calendar::replace_window(&db, account, &id, (from, to), &events)?;
                calendar::mark_calendar_synced(&db, account, &id, now_unix())?;
            }
            // A CalDAV calendar that cannot be read keeps its last window,
            // like a subscription, and the others are still refreshed.
            calendar::CalendarKind::CalDav => {
                let id = calendar.id.clone();
                let (_, transport) = match caldav_target(engine, account, &id) {
                    Ok(found) => found,
                    Err(err) => {
                        crate::mlog!(crate::log::Level::Warn, "calendar", "{id}: not refreshed: {err:#}");
                        continue;
                    }
                };
                let url = id.clone();
                let fetched = tokio::task::spawn_blocking(move || {
                    calendar::caldav::fetch_window(&transport, &url, from, to)
                })
                .await;
                let objects = match fetched {
                    Ok(Ok(objects)) => objects,
                    Ok(Err(err)) => {
                        crate::mlog!(crate::log::Level::Warn, "calendar", "{id}: not refreshed: {err:#}");
                        continue;
                    }
                    Err(err) => return Err(err.into()),
                };
                let (events, located, skipped) = calendar::caldav::events_from(&objects, &id, from, to);
                if skipped > 0 {
                    crate::mlog!(
                        crate::log::Level::Warn,
                        "calendar",
                        "{id}: {skipped} event(s) on the server could not be read"
                    );
                }
                let db = engine.db.lock().unwrap();
                calendar::replace_window(&db, account, &id, (from, to), &events)?;
                calendar::caldav::remember(&db, account, &id, &located)?;
                calendar::mark_calendar_synced(&db, account, &id, now_unix())?;
            }
            calendar::CalendarKind::Account => {
                let id = calendar.id.clone();
                let events =
                    calendar::route::events_in_window(engine, account, &id, from, to).await?;
                // An occurrence with no series identifier cannot be edited as
                // a series, and nothing on screen would explain why. Said once
                // per sync rather than per event.
                let unidentified = events
                    .iter()
                    .filter(|event| event.is_recurring && event.series_id.is_none())
                    .count();
                if unidentified > 0 {
                    crate::mlog!(
                        crate::log::Level::Warn,
                        "calendar",
                        "{id}: {unidentified} recurring occurrence(s) arrived without a series id"
                    );
                }
                let db = engine.db.lock().unwrap();
                calendar::replace_window(&db, account, &id, (from, to), &events)?;
                calendar::mark_calendar_synced(&db, account, &id, now_unix())?;
            }
        }
    }
    Ok(())
}
