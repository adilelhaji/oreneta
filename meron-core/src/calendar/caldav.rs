//! CalDAV calendars (#101, ADR-0018).
//!
//! Finding the calendars follows the same chain as CardDAV — principal, home
//! set, collections — through the same transport, so the same rules about
//! where a password may go apply (#28). Reading asks for the objects that
//! touch a window and expands them here with the RFC 5545 reader that
//! subscriptions use. Writing sends whole calendar objects, conditional on
//! the version that was read (`If-Match`); a change made elsewhere meanwhile
//! is never overwritten.

use std::collections::HashMap;

use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Utc};

use super::Event;
use crate::carddav::client::{
    is_the_book, name_from_url, propfind, resolve, resolve_trusted, same_origin, starting_point_for, DavRequest,
    Transport, Written,
};
use crate::carddav::xml::parse_multistatus_complete;

/// One calendar collection on a server.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RemoteCalendar {
    pub url: String,
    pub name: String,
    pub color: Option<String>,
    /// What `current-user-privilege-set` says, when the server says.
    pub writable: Option<bool>,
    /// What `supported-calendar-component-set` says (ADR-0070): "VEVENT",
    /// "VTODO"… `None` when the server did not say, which means every one.
    pub components: Option<Vec<String>>,
}

impl RemoteCalendar {
    /// Whether it takes events: it says so, or it does not say.
    pub fn takes_events(&self) -> bool {
        self.components.as_ref().is_none_or(|kinds| kinds.iter().any(|kind| kind == "VEVENT"))
    }

    /// Whether it can hold an account's task list, by what it declares
    /// (ADR-0070, §1).
    pub fn task_kind(&self) -> TaskKind {
        match &self.components {
            None => TaskKind::Maybe,
            Some(kinds) if !kinds.iter().any(|kind| kind == "VTODO") => TaskKind::No,
            Some(kinds) if kinds.iter().all(|kind| kind == "VTODO") => TaskKind::Only,
            Some(_) => TaskKind::Maybe,
        }
    }
}

/// Whether a collection is an account's task list (ADR-0070, §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    /// It takes tasks only: it is one.
    Only,
    /// It takes events and tasks, or does not say: it is one only if it
    /// holds a task already, which [`has_todos`] asks.
    Maybe,
    /// It takes no tasks.
    No,
}

/// One stored object: an event (with its exceptions), where it lives and
/// its version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Object {
    pub href: String,
    pub etag: String,
    pub ics: String,
}

const PROP_PRINCIPAL: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#;

const PROP_HOME_SET: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop></d:propfind>"#;

const PROP_CALENDARS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><d:current-user-privilege-set/><c:supported-calendar-component-set/></d:prop>
</d:propfind>"#;

const PROP_NAME: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>"#;

/// Finds the calendars a server holds for whoever signs in. Like CardDAV
/// discovery, each step falls back rather than failing, and nothing is
/// invented: a calendar that was not found is reported as not found.
pub fn discover(transport: &dyn Transport, input: &str) -> Result<Vec<RemoteCalendar>> {
    let start = starting_point_for(input, "/.well-known/caldav")?;
    let mut refusal: Option<anyhow::Error> = None;
    let mut remember = |error: anyhow::Error| {
        if refusal.is_none() {
            refusal = Some(error);
        }
    };

    let mut principal = String::new();
    match propfind(transport, &start, "0", PROP_PRINCIPAL) {
        Ok((responses, from)) => {
            if let Some(href) = responses.iter().find_map(|r| r.prop_href("current-user-principal")) {
                match resolve_trusted(&from, href) {
                    Ok(url) => principal = url,
                    Err(error) => remember(error),
                }
            }
        }
        Err(error) => remember(error),
    }

    let mut home = String::new();
    for candidate in [principal.as_str(), start.as_str()] {
        if candidate.is_empty() || !home.is_empty() {
            continue;
        }
        match propfind(transport, candidate, "0", PROP_HOME_SET) {
            Ok((responses, from)) => {
                if let Some(href) = responses.iter().find_map(|r| r.prop_href("calendar-home-set")) {
                    match resolve_trusted(&from, href) {
                        Ok(url) => home = url,
                        Err(error) => remember(error),
                    }
                }
            }
            Err(error) => remember(error),
        }
    }

    let mut calendars = Vec::new();
    let root = if home.is_empty() { start.clone() } else { home };
    match propfind(transport, &root, "1", PROP_CALENDARS) {
        Err(error) => remember(error),
        Ok((responses, from)) => {
            for response in responses {
                if !response.resource_types.iter().any(|kind| kind == "calendar") {
                    continue;
                }
                let Ok(url) = resolve_trusted(&from, &response.href) else { continue };
                let writable = if response.privileges.is_empty() {
                    None
                } else {
                    Some(response.privileges.iter().any(|p| matches!(p.as_str(), "write" | "write-content" | "all")))
                };
                calendars.push(RemoteCalendar {
                    name: response
                        .prop("displayname")
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| name_from_url(&url)),
                    color: response
                        .prop("calendar-color")
                        .map(|c| c.trim().chars().take(7).collect::<String>())
                        .filter(|c| c.starts_with('#') && c.len() == 7),
                    writable,
                    components: response.components.clone(),
                    url,
                });
            }
        }
    }
    if calendars.is_empty() {
        return Err(refusal.unwrap_or_else(|| anyhow!("no calendar was found on that server")));
    }
    calendars.dedup_by(|a, b| a.url == b.url);
    Ok(calendars)
}

fn stamp(instant: i64) -> String {
    DateTime::<Utc>::from_timestamp(instant, 0).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

/// Every object with an occurrence in `[from, to)`. All or nothing, like the
/// address books (#28): an object the server failed to send makes this an
/// error, and the caller keeps the window it has.
pub fn fetch_window(transport: &dyn Transport, calendar_url: &str, from: i64, to: i64) -> Result<Vec<Object>> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="{}" end="{}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>"#,
        stamp(from),
        stamp(to)
    );
    query(transport, calendar_url, body, "events")
}

/// Every task (VTODO) in a collection, with no time window: a task list is
/// read whole. All or nothing, like [`fetch_window`] (ADR-0039).
pub fn fetch_todos(transport: &dyn Transport, calendar_url: &str) -> Result<Vec<Object>> {
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>"#;
    query(transport, calendar_url, body.to_string(), "tasks")
}

/// Whether a collection holds at least one task (ADR-0070, §1): the
/// question asked of one that takes events and tasks, or does not say. Only
/// versions are asked for, not the tasks. An answer that cannot be read is
/// an error, never a "no".
pub fn has_todos(transport: &dyn Transport, calendar_url: &str) -> Result<bool> {
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>"#;
    let reply = transport.send(&DavRequest {
        method: "REPORT",
        url: calendar_url.to_string(),
        depth: Some("1"),
        body: Some(body.to_string()),
        ..Default::default()
    })?;
    match reply.status {
        401 | 403 => bail!("the server refused those credentials"),
        404 | 410 => bail!("this calendar is no longer on the server"),
        status if status >= 300 => bail!("the server would not say whether the calendar holds tasks (HTTP {status})"),
        _ => {}
    }
    Ok(parse_multistatus_complete(&reply.body)?.iter().any(|response| !is_the_book(response, calendar_url)))
}

/// What the server calls a collection, or a name made from its address
/// when it gives none. A name is not worth failing a read over: an answer
/// that cannot be read gives the name from the address too.
pub fn collection_name(transport: &dyn Transport, calendar_url: &str) -> String {
    propfind(transport, calendar_url, "0", PROP_NAME)
        .ok()
        .and_then(|(responses, _)| {
            responses
                .iter()
                .find_map(|response| response.prop("displayname").map(str::trim).filter(|name| !name.is_empty()).map(str::to_string))
        })
        .unwrap_or_else(|| name_from_url(calendar_url))
}

/// A calendar query, every object in the answer or an error. An object on
/// another server, or one the server failed to send, fails the whole read.
fn query(transport: &dyn Transport, calendar_url: &str, body: String, what: &str) -> Result<Vec<Object>> {
    let reply = transport.send(&DavRequest {
        method: "REPORT",
        url: calendar_url.to_string(),
        depth: Some("1"),
        body: Some(body),
        ..Default::default()
    })?;
    match reply.status {
        401 | 403 => bail!("the server refused those credentials"),
        404 | 410 => bail!("this calendar is no longer on the server"),
        status if status >= 300 => bail!("the server would not list the calendar (HTTP {status})"),
        _ => {}
    }
    let mut objects = Vec::new();
    let mut failed = Vec::new();
    for response in parse_multistatus_complete(&reply.body)? {
        if is_the_book(&response, calendar_url) {
            continue;
        }
        let Some(ics) = response.prop("calendar-data").filter(|data| data.contains("BEGIN:VCALENDAR")) else {
            failed.push(response.href.clone());
            continue;
        };
        let href = resolve(&reply.url, &response.href)?;
        if !same_origin(&href, calendar_url) {
            failed.push(response.href.clone());
            continue;
        }
        objects.push(Object {
            href,
            etag: response.prop("getetag").unwrap_or_default().to_string(),
            ics: ics.to_string(),
        });
    }
    if !failed.is_empty() {
        bail!(
            "{} of {} {what} could not be read (first: {}); the last complete copy is kept",
            failed.len(),
            failed.len() + objects.len(),
            failed[0]
        );
    }
    Ok(objects)
}

/// Where an event is stored on the server: its object and version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub uid: String,
    pub href: String,
    pub etag: String,
}

/// The occurrences in a window, each carrying its object's version as its
/// change key, and where each series lives.
pub fn events_from(objects: &[Object], calendar_id: &str, from: i64, to: i64) -> (Vec<Event>, Vec<Located>, usize) {
    let mut events = Vec::new();
    let mut located = Vec::new();
    let mut skipped = 0usize;
    for object in objects {
        match super::subscription::parse_window(&object.ics, calendar_id, from, to) {
            Ok((mut found, bad)) => {
                skipped += bad;
                let reminders = super::ics::reminders(&object.ics);
                let mut uids: Vec<String> = Vec::new();
                for event in &mut found {
                    let uid = super::ics::occurrence_of(&event.id)
                        .map(|(uid, _)| uid.to_string())
                        .unwrap_or_else(|| event.id.clone());
                    event.change_key = Some(object.etag.clone());
                    event.reminder_minutes = reminders.get(&uid).copied();
                    if !uids.contains(&uid) {
                        uids.push(uid);
                    }
                }
                for uid in uids {
                    located.push(Located { uid, href: object.href.clone(), etag: object.etag.clone() });
                }
                events.append(&mut found);
            }
            Err(_) => skipped += 1,
        }
    }
    (events, located, skipped)
}

/// One object and its version, or `None` when it is no longer there.
pub fn get_object(transport: &dyn Transport, calendar_url: &str, href: &str) -> Result<Option<(String, String)>> {
    guard(calendar_url, href)?;
    let reply = transport.send(&DavRequest { method: "GET", url: href.to_string(), ..Default::default() })?;
    match reply.status {
        401 | 403 => bail!("the server refused those credentials"),
        404 | 410 => Ok(None),
        status if status >= 300 => bail!("the server would not send the event (HTTP {status})"),
        _ => Ok(Some((reply.body, reply.etag.unwrap_or_default()))),
    }
}

/// Writes an object over the version `if_match` names, or, with `None`,
/// only where nothing is yet.
pub fn put_object(
    transport: &dyn Transport,
    calendar_url: &str,
    href: &str,
    ics: &str,
    if_match: Option<&str>,
) -> Result<Written> {
    guard(calendar_url, href)?;
    let condition = match if_match {
        Some(etag) if !etag.is_empty() => ("If-Match", etag.to_string()),
        Some(_) => bail!("this event's version on the server is not known yet; refresh the calendar and try again"),
        None => ("If-None-Match", "*".to_string()),
    };
    let reply = transport.send(&DavRequest {
        method: "PUT",
        url: href.to_string(),
        body: Some(ics.to_string()),
        headers: vec![("Content-Type", "text/calendar; charset=utf-8".to_string()), condition],
        ..Default::default()
    })?;
    match reply.status {
        412 => Ok(Written::Conflict),
        401 | 403 => bail!("the server refused to change this calendar"),
        status if status >= 300 => bail!("the server did not save the event (HTTP {status})"),
        _ => Ok(Written::Saved { etag: reply.etag }),
    }
}

pub fn delete_object(transport: &dyn Transport, calendar_url: &str, href: &str, etag: &str) -> Result<Written> {
    guard(calendar_url, href)?;
    if etag.is_empty() {
        bail!("this event's version on the server is not known yet; refresh the calendar and try again");
    }
    let reply = transport.send(&DavRequest {
        method: "DELETE",
        url: href.to_string(),
        headers: vec![("If-Match", etag.to_string())],
        ..Default::default()
    })?;
    match reply.status {
        412 => Ok(Written::Conflict),
        404 | 410 => Ok(Written::Saved { etag: None }),
        401 | 403 => bail!("the server refused to change this calendar"),
        status if status >= 300 => bail!("the server did not delete the event (HTTP {status})"),
        _ => Ok(Written::Saved { etag: None }),
    }
}

/// An event is written only on its calendar's own server (#28).
fn guard(calendar_url: &str, href: &str) -> Result<()> {
    if !same_origin(calendar_url, href) {
        bail!("that event is not on this calendar's server; nothing was sent");
    }
    Ok(())
}

/// A URL for a new object in a collection.
pub fn new_href(calendar_url: &str, uid: &str) -> Result<String> {
    let safe: String = uid.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    resolve(&format!("{}/", calendar_url.trim_end_matches('/')), &format!("{safe}.ics"))
}

/// What a write did, for the caller to report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Saved { href: String, etag: Option<String> },
    /// Changed or removed elsewhere since it was read: nothing was written.
    Conflict,
}

/// A new event, in a new object.
pub fn create(transport: &dyn Transport, calendar_url: &str, event: &Event, now: i64) -> Result<(String, Change)> {
    let uid = format!("{}@oreneta", uuid::Uuid::new_v4());
    let href = new_href(calendar_url, &uid)?;
    let ics = super::ics::new_object(event, &uid, now);
    Ok((uid, match put_object(transport, calendar_url, &href, &ics, None)? {
        Written::Saved { etag } => Change::Saved { href, etag },
        Written::Conflict => Change::Conflict,
    }))
}

/// An edit: of the event, of the whole series, or of one occurrence. Made
/// on the object as the server has it now, and sent only if that is still
/// the version the person was looking at (`seen`). `removed` names the
/// attendees the editor took out; anyone else on the object stays.
#[allow(clippy::too_many_arguments)]
pub fn update(
    transport: &dyn Transport,
    calendar_url: &str,
    href: &str,
    seen: &str,
    event: &Event,
    whole_series: bool,
    removed: &[String],
    now: i64,
) -> Result<Change> {
    let Some((ics, etag)) = get_object(transport, calendar_url, href)? else {
        return Ok(Change::Conflict);
    };
    if !seen.is_empty() && !etag.is_empty() && seen != etag {
        return Ok(Change::Conflict);
    }
    let patched = if event.is_recurring && !whole_series {
        super::ics::put_override(&ics, event, removed, now)?
    } else {
        super::ics::patch_event(&ics, event, whole_series, removed, now)?
    };
    let version = if etag.is_empty() { seen } else { etag.as_str() };
    Ok(match put_object(transport, calendar_url, href, &patched, Some(version))? {
        Written::Saved { etag } => Change::Saved { href: href.to_string(), etag },
        Written::Conflict => Change::Conflict,
    })
}

/// Deleting an event or a whole series removes its object; deleting one
/// occurrence excludes it from the series.
pub fn delete(
    transport: &dyn Transport,
    calendar_url: &str,
    href: &str,
    seen: &str,
    event_id: &str,
    all_day: bool,
    occurrence_only: bool,
) -> Result<Change> {
    if !occurrence_only {
        return Ok(match delete_object(transport, calendar_url, href, seen)? {
            Written::Saved { .. } => Change::Saved { href: href.to_string(), etag: None },
            Written::Conflict => Change::Conflict,
        });
    }
    let Some((ics, etag)) = get_object(transport, calendar_url, href)? else {
        return Ok(Change::Saved { href: href.to_string(), etag: None });
    };
    if !seen.is_empty() && !etag.is_empty() && seen != etag {
        return Ok(Change::Conflict);
    }
    let patched = super::ics::exclude_occurrence(&ics, event_id, all_day)?;
    let version = if etag.is_empty() { seen } else { etag.as_str() };
    Ok(match put_object(transport, calendar_url, href, &patched, Some(version))? {
        Written::Saved { etag } => Change::Saved { href: href.to_string(), etag },
        Written::Conflict => Change::Conflict,
    })
}

/// Where each series of a calendar lives, kept between reads so a write
/// knows which object to change.
pub fn remember(conn: &rusqlite::Connection, account: &str, calendar_id: &str, located: &[Located]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for item in located {
        tx.execute(
            "INSERT INTO caldav_objects(account, calendar_id, uid, href, etag) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account, calendar_id, uid) DO UPDATE SET href = excluded.href, etag = excluded.etag",
            rusqlite::params![account, calendar_id, item.uid, item.href, item.etag],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn locate(conn: &rusqlite::Connection, account: &str, calendar_id: &str, uid: &str) -> Result<Option<Located>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            "SELECT uid, href, etag FROM caldav_objects WHERE account = ?1 AND calendar_id = ?2 AND uid = ?3",
            rusqlite::params![account, calendar_id, uid],
            |row| Ok(Located { uid: row.get(0)?, href: row.get(1)?, etag: row.get(2)? }),
        )
        .optional()?)
}

pub fn forget(conn: &rusqlite::Connection, account: &str, calendar_id: &str, uid: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM caldav_objects WHERE account = ?1 AND calendar_id = ?2 AND uid = ?3",
        rusqlite::params![account, calendar_id, uid],
    )?;
    Ok(())
}

/// The keychain entry holding a CalDAV calendar's password.
pub fn secret_key(account: &str, calendar_id: &str) -> String {
    format!("caldav:{account}:{calendar_id}")
}

/// Keeps the calendars chosen from a server under an account. Each is its
/// own row (its URL is its id) with the user name it signs in with; the
/// password goes to the keychain under [`secret_key`].
pub fn add_calendars(
    conn: &rusqlite::Connection,
    account: &str,
    found: &[RemoteCalendar],
    username: &str,
) -> Result<Vec<String>> {
    let calendars: Vec<super::Calendar> = found
        .iter()
        .map(|remote| super::Calendar {
            id: remote.url.clone(),
            name: remote.name.clone(),
            color: remote.color.clone(),
            kind: super::CalendarKind::CalDav,
            url: Some(remote.url.clone()),
            read_only: remote.writable == Some(false),
            enabled: true,
            ..Default::default()
        })
        .collect();
    super::upsert_calendars(conn, account, &calendars)?;
    for calendar in &calendars {
        conn.execute(
            "UPDATE calendars SET dav_username = ?3 WHERE account = ?1 AND provider_id = ?2",
            rusqlite::params![account, calendar.id, username],
        )?;
    }
    Ok(calendars.into_iter().map(|c| c.id).collect())
}

/// The URL and user name a CalDAV calendar signs in with.
pub fn sign_in(conn: &rusqlite::Connection, account: &str, calendar_id: &str) -> Result<Option<(String, String)>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            "SELECT url, dav_username FROM calendars WHERE account = ?1 AND provider_id = ?2 AND kind = 'caldav'",
            rusqlite::params![account, calendar_id],
            |row| Ok((row.get::<_, Option<String>>(0)?.unwrap_or_default(), row.get(1)?)),
        )
        .optional()?)
}

/// Every CalDAV calendar of an account, for removing their passwords.
pub fn calendar_ids(conn: &rusqlite::Connection, account: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT provider_id FROM calendars WHERE account = ?1 AND kind = 'caldav'")?;
    let rows = stmt.query_map(rusqlite::params![account], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    let has = conn
        .prepare("SELECT 1 FROM pragma_table_info('calendars') WHERE name = 'dav_username'")?
        .exists([])?;
    if !has {
        conn.execute_batch("ALTER TABLE calendars ADD COLUMN dav_username TEXT NOT NULL DEFAULT ''")?;
    }
    Ok(())
}

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS caldav_objects (
  account     TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  uid         TEXT NOT NULL,
  href        TEXT NOT NULL,
  etag        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account, calendar_id, uid)
);
";

/// The series id of an occurrence, or the event's own id.
pub fn uid_of(event_id: &str) -> String {
    super::ics::occurrence_of(event_id).map(|(uid, _)| uid.to_string()).unwrap_or_else(|| event_id.to_string())
}

/// For tests and callers holding a list: objects by UID.
pub fn by_uid(located: &[Located]) -> HashMap<&str, &Located> {
    located.iter().map(|l| (l.uid.as_str(), l)).collect()
}

#[cfg(test)]
mod tests;
