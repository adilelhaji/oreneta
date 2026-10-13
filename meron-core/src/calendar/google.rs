//! Google Calendar, over the REST API v3.
//!
//! Exchange speaks SOAP through a pooled session; Google speaks JSON over
//! plain HTTPS with a bearer token and keeps nothing between calls. That is
//! why calendars are not dispatched through the mail `Session`: an account's
//! mail and its calendar are different protocols with different lifetimes, and
//! Gmail's mail arrives over IMAP, which has no calendar at all.
//!
//! Recurrence is expanded by the server, as everywhere else in this codebase:
//! `singleEvents=true` asks Google to return concrete instances rather than
//! the rules behind them. See [`crate::calendar::subscription`] for the one
//! place that has no server to ask.

use anyhow::{Context as _, Result};
use serde::Deserialize;

use super::{Calendar, CalendarKind, Event, Participant};

const API: &str = "https://www.googleapis.com/calendar/v3";

/// Cap on one request. Generous enough for a busy month, short enough that a
/// hung connection does not wedge a sync.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Cap on the occurrences one window may return. A window is a screenful of
/// calendar, not an archive.
const MAX_EVENTS: usize = 2500;

// ---- Wire types -------------------------------------------------------------
//
// Only the fields this client uses are modelled. Google adds fields over time
// and serde ignores the rest, so an unknown one is not an error.

#[derive(Deserialize)]
struct CalendarList {
    #[serde(default)]
    items: Vec<CalendarListEntry>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct CalendarListEntry {
    id: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    primary: bool,
    /// "owner", "writer", "reader" or "freeBusyReader". Anything below writer
    /// cannot be edited — a calendar shared with this mailbox, or a public one.
    #[serde(rename = "accessRole", default)]
    access_role: String,
    #[serde(default)]
    deleted: bool,
    /// The colour this calendar is drawn in on Google's own clients, as
    /// `#rrggbb`. Worth carrying: a reader who has told Google that work is
    /// green should not have to say it again here.
    #[serde(rename = "backgroundColor", default)]
    background_color: Option<String>,
}

#[derive(Deserialize)]
struct EventList {
    #[serde(default)]
    items: Vec<GoogleEvent>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct GoogleEvent {
    #[serde(default)]
    id: String,
    #[serde(default)]
    etag: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    description: Option<String>,
    start: Option<EventDateTime>,
    end: Option<EventDateTime>,
    #[serde(rename = "recurringEventId", default)]
    recurring_event_id: Option<String>,
    #[serde(default)]
    transparency: Option<String>,
    #[serde(default)]
    organizer: Option<GooglePerson>,
    #[serde(default)]
    attendees: Vec<GoogleAttendee>,
    #[serde(default)]
    reminders: Option<GoogleReminders>,
    #[serde(rename = "hangoutLink", default)]
    hangout_link: Option<String>,
    #[serde(rename = "conferenceData", default)]
    conference_data: Option<ConferenceData>,
}

/// The meeting Google keeps on an event (#109).
#[derive(Deserialize, Default)]
struct ConferenceData {
    #[serde(rename = "entryPoints", default)]
    entry_points: Vec<EntryPoint>,
    #[serde(rename = "conferenceSolution", default)]
    solution: Option<Solution>,
    #[serde(rename = "createRequest", default)]
    create_request: Option<CreateRequest>,
}

#[derive(Deserialize)]
struct EntryPoint {
    #[serde(rename = "entryPointType", default)]
    kind: String,
    #[serde(default)]
    uri: String,
}

#[derive(Deserialize)]
struct Solution {
    #[serde(default)]
    key: Option<SolutionKey>,
}

#[derive(Deserialize)]
struct SolutionKey {
    #[serde(rename = "type", default)]
    kind: String,
}

#[derive(Deserialize)]
struct CreateRequest {
    #[serde(default)]
    status: Option<CreateStatus>,
}

#[derive(Deserialize)]
struct CreateStatus {
    #[serde(rename = "statusCode", default)]
    code: String,
}

/// The meeting Google bound to an event, and whether one asked for is ready.
fn google_meeting(
    data: Option<&ConferenceData>,
    hangout: Option<&str>,
) -> (Option<super::meeting::Meeting>, Option<String>) {
    let status = data
        .and_then(|d| d.create_request.as_ref())
        .and_then(|r| r.status.as_ref())
        .map(|s| s.code.clone());
    let video = data.and_then(|d| d.entry_points.iter().find(|e| e.kind == "video" && e.uri.starts_with("https://")));
    let provider = match data.and_then(|d| d.solution.as_ref()).and_then(|s| s.key.as_ref()).map(|k| k.kind.as_str()) {
        Some("hangoutsMeet") | None => "meet".to_string(),
        // An add-on (Zoom, Teams…) installed in Google Calendar: name it by
        // its address.
        Some(_) => video
            .and_then(|e| super::meeting::detect(&e.uri))
            .map(|m| m.provider)
            .unwrap_or_else(|| "other".into()),
    };
    let url = video.map(|e| e.uri.clone()).or_else(|| hangout.map(str::to_string));
    (url.map(|url| super::meeting::Meeting { provider, url }), status)
}

#[derive(Deserialize)]
struct GoogleReminders {
    /// Whether the calendar's own default applies. When it does, the minutes
    /// live on the calendar rather than the event, so this client shows no
    /// reminder of its own rather than inventing a number.
    #[serde(rename = "useDefault", default)]
    use_default: bool,
    #[serde(default)]
    overrides: Vec<GoogleReminderOverride>,
}

#[derive(Deserialize)]
struct GoogleReminderOverride {
    #[serde(default)]
    minutes: Option<i64>,
}

#[derive(Deserialize)]
struct EventDateTime {
    /// Set on a timed event, RFC 3339 with an offset.
    #[serde(rename = "dateTime")]
    date_time: Option<String>,
    /// Set on an all-day event: a calendar date with no time at all.
    date: Option<String>,
}

#[derive(Deserialize)]
struct GooglePerson {
    #[serde(default)]
    email: Option<String>,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct GoogleAttendee {
    #[serde(default)]
    email: Option<String>,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "responseStatus", default)]
    response_status: Option<String>,
    /// Whether this attendee is the mailbox asking.
    #[serde(rename = "self", default)]
    is_self: bool,
}

#[derive(Deserialize)]
struct CreatedEvent {
    #[serde(default)]
    id: String,
    #[serde(default)]
    etag: Option<String>,
    #[serde(rename = "hangoutLink", default)]
    hangout_link: Option<String>,
    #[serde(rename = "conferenceData", default)]
    conference_data: Option<ConferenceData>,
}

#[derive(Deserialize)]
struct CreatedCalendar {
    #[serde(default)]
    id: String,
}

// ---- Requests ---------------------------------------------------------------

/// One authenticated call. Blocking, like the rest of this crate's HTTP;
/// callers wrap it in `spawn_blocking`.
fn call(token: &str, method: &str, url: &str, body: Option<serde_json::Value>) -> Result<String> {
    call_with(token, method, url, body, None)
}

/// [`call`] with an optional `If-Match`: the write happens only if the event
/// is still the version that was read, and is refused with 412 otherwise.
fn call_with(
    token: &str,
    method: &str,
    url: &str,
    body: Option<serde_json::Value>,
    if_match: Option<&str>,
) -> Result<String> {
    let url = &test_base(url);
    let agent = crate::proxy::agent()?;
    let authorization = format!("Bearer {token}");

    // A request that carries a body and one that does not are different types
    // in the HTTP client, so the two paths are built separately rather than
    // through one branch. Both keep a non-2xx as a response rather than a
    // transport error, so the sentence Google puts in the body reaches the
    // user instead of a bare status code.
    // Serialised here rather than through the client's own JSON helper: that
    // helper is behind a crate feature this project does not enable, and one
    // less feature flag is worth one line of code.
    let payload = match &body {
        Some(json) => serde_json::to_string(json).context("serialise request")?,
        None => String::new(),
    };

    let mut response = match (method, body) {
        ("GET", _) => agent
            .get(url)
            .header("Authorization", &authorization)
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .call()
            .with_context(|| format!("{method} {url}"))?,
        ("DELETE", _) => with_if_match(agent.delete(url), if_match)
            .header("Authorization", &authorization)
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .call()
            .with_context(|| format!("{method} {url}"))?,
        ("POST", Some(_)) => agent
            .post(url)
            .header("Authorization", &authorization)
            .header("Content-Type", "application/json")
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .send(payload.as_str())
            .with_context(|| format!("{method} {url}"))?,
        ("PATCH", Some(_)) => with_if_match(agent.patch(url), if_match)
            .header("Authorization", &authorization)
            .header("Content-Type", "application/json")
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .send(payload.as_str())
            .with_context(|| format!("{method} {url}"))?,
        (other, _) => anyhow::bail!("unsupported request {other} {url}"),
    };

    let status = response.status();
    let text = response
        .body_mut()
        .read_to_string()
        .with_context(|| format!("read {method} {url}"))?;
    if !status.is_success() {
        anyhow::bail!("{}", explain(status.as_u16(), &text));
    }
    Ok(text)
}

fn with_if_match<B>(request: ureq::RequestBuilder<B>, if_match: Option<&str>) -> ureq::RequestBuilder<B> {
    match if_match.filter(|tag| !tag.is_empty()) {
        Some(tag) => request.header("If-Match", tag),
        None => request,
    }
}

// Tests point the client at a local server, per thread, so they can see the
// requests it makes and answer them. Never set outside tests.
#[cfg(test)]
thread_local! {
    static TEST_BASE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn test_base(url: &str) -> String {
    TEST_BASE.with(|base| match base.borrow().as_deref() {
        Some(base) => url.replacen(API, base, 1),
        None => url.to_string(),
    })
}

#[cfg(not(test))]
fn test_base(url: &str) -> String {
    url.to_string()
}

/// What to tell the user about a refused call.
///
/// The one refusal worth naming is a token that predates the calendar
/// permission: the account works, the calendar does not, and nothing the user
/// can see says why. Reconnecting is the fix, so the message says so instead
/// of repeating Google's wording about scopes.
fn explain(status: u16, body: &str) -> String {
    let message = brief(body);
    let needs_consent = status == 403 && message.to_lowercase().contains("scope")
        || body.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    if needs_consent {
        return "this account has not granted calendar access yet — reconnect it \
                to sign in again and allow the calendar"
            .to_string();
    }
    if status == 412 {
        return "this event was changed elsewhere since it was opened; nothing was \
                saved — open it again to see the latest version"
            .to_string();
    }
    format!("Google Calendar answered {status}: {message}")
}

/// The human part of an API error, when there is one. Google answers with a
/// JSON envelope; showing the whole thing buries the sentence that matters.
fn brief(body: &str) -> String {
    #[derive(Deserialize)]
    struct ErrorEnvelope {
        error: Option<ErrorBody>,
    }
    #[derive(Deserialize)]
    struct ErrorBody {
        message: Option<String>,
    }
    serde_json::from_str::<ErrorEnvelope>(body)
        .ok()
        .and_then(|envelope| envelope.error.and_then(|error| error.message))
        .unwrap_or_else(|| body.chars().take(200).collect())
}

/// The calendars this account can see.
pub fn list_calendars(token: &str) -> Result<Vec<Calendar>> {
    let mut calendars = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let url = match &page {
            Some(token) => format!("{API}/users/me/calendarList?maxResults=250&pageToken={token}"),
            None => format!("{API}/users/me/calendarList?maxResults=250"),
        };
        let list: CalendarList =
            serde_json::from_str(&call(token, "GET", &url, None)?).context("parse calendar list")?;
        for entry in list.items {
            // A calendar the account removed from its list is not one of its
            // own any more, the same way a deleted Exchange folder is not.
            if entry.deleted {
                continue;
            }
            calendars.push(Calendar {
                id: entry.id,
                name: entry.summary,
                is_default: entry.primary,
                // Both are this client's to decide and are preserved across
                // syncs by the store.
                enabled: true,
                color: entry
                    .background_color
                    .filter(|colour| colour.starts_with('#') && colour.len() == 7),
                kind: CalendarKind::Account,
                url: None,
                // Anything below "writer" is someone else's calendar shared
                // with this one: showing an edit that the server will refuse
                // would be worse than saying it cannot be edited.
                read_only: !matches!(entry.access_role.as_str(), "owner" | "writer"),
                synced_at: 0,
            });
        }
        match list.next_page_token {
            Some(next) => page = Some(next),
            None => break,
        }
    }
    Ok(calendars)
}

/// The occurrences on a calendar between two instants, series expanded.
pub fn events_in_window(
    token: &str,
    calendar_id: &str,
    from: i64,
    to: i64,
) -> Result<Vec<Event>> {
    let time_min = rfc3339(from).context("window start")?;
    let time_max = rfc3339(to).context("window end")?;
    let mut events = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let mut url = format!(
            "{API}/calendars/{}/events?singleEvents=true&orderBy=startTime\
             &maxResults=250&showDeleted=false&timeMin={}&timeMax={}",
            urlencode(calendar_id),
            urlencode(&time_min),
            urlencode(&time_max),
        );
        if let Some(token) = &page {
            url.push_str("&pageToken=");
            url.push_str(&urlencode(token));
        }
        let list: EventList =
            serde_json::from_str(&call(token, "GET", &url, None)?).context("parse events")?;
        for source in list.items {
            if let Some(event) = to_event(source, calendar_id) {
                events.push(event);
            }
        }
        if events.len() >= MAX_EVENTS {
            break;
        }
        match list.next_page_token {
            Some(next) => page = Some(next),
            None => break,
        }
    }
    Ok(events)
}

/// What Google is told about telling the people on an event.
///
/// Explicit either way rather than left to the default, since the default is
/// the server's opinion and this decision is the reader's.
fn updates_query(notify: bool) -> &'static str {
    if notify { "sendUpdates=all" } else { "sendUpdates=none" }
}

/// Creates an event and returns it with the id the server assigned.
pub fn create_event(token: &str, event: &Event, notify: bool) -> Result<Event> {
    let mut body = event_body(event, true)?;
    let meeting = meeting_request(event, &meeting_key(event))?;
    if let Some(conference) = &meeting {
        body["conferenceData"] = conference.clone();
    }
    let url = format!(
        "{API}/calendars/{}/events?{}{}",
        urlencode(&event.calendar_id),
        updates_query(notify),
        if meeting.is_some() { "&conferenceDataVersion=1" } else { "" },
    );
    let created: CreatedEvent = serde_json::from_str(&call(token, "POST", &url, Some(body))?)
        .context("parse created event")?;
    let (found, status) = google_meeting(created.conference_data.as_ref(), created.hangout_link.as_deref());
    Ok(Event {
        id: created.id,
        change_key: created.etag,
        meeting_status: meeting.as_ref().map(|_| meeting_status(found.as_ref(), status.as_deref())),
        meeting: found,
        add_meeting: None,
        ..event.clone()
    })
}

/// The key a new event's meeting request is made from: the same event asked
/// for twice asks for the same meeting.
fn meeting_key(event: &Event) -> String {
    if !event.id.is_empty() {
        return event.id.clone();
    }
    format!("{}\0{}\0{}\0{}", event.subject, event.start, event.end, event.calendar_id)
}

/// What to send for an asked-for meeting: a Meet to create, `null` to remove
/// the one there, or nothing to leave it as it is.
fn meeting_request(event: &Event, key: &str) -> Result<Option<serde_json::Value>> {
    match event.add_meeting.as_deref() {
        None => Ok(None),
        Some("none") => Ok(Some(serde_json::Value::Null)),
        Some("meet") => {
            if event.meeting.as_ref().is_some_and(|m| m.provider == "meet") {
                // There is one already: asking again would make a second.
                return Ok(None);
            }
            Ok(Some(serde_json::json!({
                "createRequest": {
                    "requestId": super::meeting::request_id(&event.calendar_id, key),
                    "conferenceSolutionKey": { "type": "hangoutsMeet" },
                }
            })))
        }
        Some(other) => anyhow::bail!("{other} meetings cannot be created here"),
    }
}

/// Ready, still being set up, or refused (an account without Meet).
fn meeting_status(found: Option<&super::meeting::Meeting>, status: Option<&str>) -> String {
    match (found, status) {
        (Some(_), _) => "ready",
        (None, Some("pending")) => "pending",
        _ => "failed",
    }
    .to_string()
}

/// Updates an event in place. PATCH rather than PUT: only the fields this
/// client owns are sent, so anything Google keeps that Meron does not model —
/// conferencing links, reminders, colours — survives the edit.
pub fn update_event(
    token: &str,
    event: &Event,
    whole_series: bool,
    notify: bool,
) -> Result<Option<String>> {
    // Changing the series means changing the master it was expanded from;
    // changing this one means changing the instance, which Google records as
    // an exception and leaves the rest of the series alone.
    let (target, mut body, version) = match (whole_series, event.series_id.as_deref()) {
        (true, Some(series)) => {
            // The occurrence being edited is not where the series starts.
            // Writing its date onto the master moved the start of the series
            // to it, and every earlier occurrence was gone. The master keeps
            // its own first date and takes the new time of day and length.
            let master_url = format!(
                "{API}/calendars/{}/events/{}",
                urlencode(&event.calendar_id),
                urlencode(series),
            );
            #[derive(Deserialize)]
            struct Master {
                start: Option<EventDateTime>,
                #[serde(default)]
                etag: Option<String>,
            }
            let master: Master = serde_json::from_str(&call(token, "GET", &master_url, None)?)
                .context("read the series")?;
            let first = master
                .start
                .as_ref()
                .and_then(instant)
                .context("the series has no start")?;
            let anchored = anchored_to_series(event, first).context("place the series")?;
            (series, event_body(&anchored, true)?, master.etag)
        }
        // An occurrence cannot carry a rule of its own; only the series can.
        (false, Some(_)) => (event.id.as_str(), event_body(event, false)?, event.change_key.clone()),
        _ => (event.id.as_str(), event_body(event, true)?, event.change_key.clone()),
    };
    // A meeting added or removed with this save (#109); left out, the one
    // there stays, since this is a PATCH.
    let meeting = meeting_request(event, target)?;
    if let Some(conference) = &meeting {
        body["conferenceData"] = conference.clone();
    }
    let url = format!(
        "{API}/calendars/{}/events/{}?{}{}",
        urlencode(&event.calendar_id),
        urlencode(target),
        updates_query(notify),
        if meeting.is_some() { "&conferenceDataVersion=1" } else { "" },
    );
    // Sent with the version it was read at, so an edit made elsewhere in
    // between is refused (412) rather than silently overwritten.
    let answer = call_with(token, "PATCH", &url, Some(body), version.as_deref())?;
    if whole_series && event.series_id.is_some() {
        // The new version is the master's; the occurrence on screen has its
        // own, which the sync that follows brings.
        return Ok(None);
    }
    Ok(serde_json::from_str::<CreatedEvent>(&answer)
        .ok()
        .and_then(|updated| updated.etag))
}

/// The edited occurrence's times moved onto the series' first date: same
/// time of day (in this machine's zone, which is the zone the series is
/// written in) and same length.
fn anchored_to_series(event: &Event, series_start: i64) -> Option<Event> {
    use chrono::TimeZone as _;
    let length = (event.end - event.start).max(0);
    let start = if event.all_day {
        // All-day dates are UTC dates throughout this module.
        let date = chrono::DateTime::from_timestamp(series_start, 0)?.date_naive();
        date.and_hms_opt(0, 0, 0)?.and_utc().timestamp()
    } else {
        let date = chrono::Local.timestamp_opt(series_start, 0).earliest()?.date_naive();
        let time = chrono::Local.timestamp_opt(event.start, 0).earliest()?.time();
        chrono::Local
            .from_local_datetime(&date.and_time(time))
            .earliest()?
            .timestamp()
    };
    Some(Event {
        start,
        end: start + length,
        ..event.clone()
    })
}

/// Answers a meeting invitation.
///
/// Google keeps the answer on the attendee list, so this reads the event,
/// changes only the entry belonging to this mailbox, and sends the list back —
/// PATCHing attendees replaces the whole list, and rebuilding it from a
/// stale copy would drop whoever joined in between.
pub fn respond(
    token: &str,
    calendar_id: &str,
    event_id: &str,
    response: super::Response,
) -> Result<()> {
    let url = format!(
        "{API}/calendars/{}/events/{}",
        urlencode(calendar_id),
        urlencode(event_id),
    );
    // The list is read and written back, so the write is made conditional on
    // the version read: someone added in between is kept by reading again,
    // once, rather than dropped.
    match answer_once(token, &url, response) {
        Err(err) if format!("{err:#}").contains("changed elsewhere") => {
            answer_once(token, &url, response)
        }
        other => other,
    }
}

fn answer_once(token: &str, url: &str, response: super::Response) -> Result<()> {
    #[derive(Deserialize)]
    struct Current {
        #[serde(default)]
        attendees: Vec<serde_json::Value>,
        #[serde(default)]
        etag: Option<String>,
    }
    let current: Current =
        serde_json::from_str(&call(token, "GET", url, None)?).context("read event to answer")?;

    let mut attendees = current.attendees;
    let mut answered = false;
    for attendee in attendees.iter_mut() {
        if attendee.get("self").and_then(serde_json::Value::as_bool) == Some(true) {
            if let Some(object) = attendee.as_object_mut() {
                object.insert(
                    "responseStatus".to_string(),
                    serde_json::Value::String(response.google_status().to_string()),
                );
                answered = true;
            }
        }
    }
    if !answered {
        anyhow::bail!("this account is not on the invitation");
    }

    call_with(
        token,
        "PATCH",
        url,
        Some(serde_json::json!({ "attendees": attendees })),
        current.etag.as_deref(),
    )?;
    Ok(())
}

pub fn delete_event(
    token: &str,
    calendar_id: &str,
    event_id: &str,
    notify: bool,
) -> Result<()> {
    let url = format!(
        "{API}/calendars/{}/events/{}?{}",
        urlencode(calendar_id),
        urlencode(event_id),
        updates_query(notify),
    );
    // A delete of something already gone is what was asked for, not a failure.
    match call(token, "DELETE", &url, None) {
        Ok(_) => Ok(()),
        Err(err) if format!("{err:#}").contains("410") => Ok(()),
        Err(err) => Err(err),
    }
}

pub fn create_calendar(token: &str, name: &str) -> Result<String> {
    let url = format!("{API}/calendars");
    let created: CreatedCalendar = serde_json::from_str(&call(
        token,
        "POST",
        &url,
        Some(serde_json::json!({ "summary": name })),
    )?)
    .context("parse created calendar")?;
    Ok(created.id)
}

pub fn rename_calendar(token: &str, calendar_id: &str, name: &str) -> Result<()> {
    // The entry in *this account's* list is what carries the name it shows,
    // which is also the only name a shared calendar lets this account change.
    let url = format!("{API}/users/me/calendarList/{}", urlencode(calendar_id));
    call(
        token,
        "PATCH",
        &url,
        Some(serde_json::json!({ "summaryOverride": name })),
    )?;
    Ok(())
}

/// Removes a calendar: deleted if this account owns it, otherwise unsubscribed.
///
/// Google refuses to delete the primary calendar and any calendar this account
/// does not own; removing it from the list is what "remove" means for those,
/// and is what the other clients do.
pub fn delete_calendar(token: &str, calendar_id: &str, owned: bool) -> Result<()> {
    let url = if owned {
        format!("{API}/calendars/{}", urlencode(calendar_id))
    } else {
        format!("{API}/users/me/calendarList/{}", urlencode(calendar_id))
    };
    call(token, "DELETE", &url, None)?;
    Ok(())
}

// ---- Mapping ----------------------------------------------------------------

/// The reader's own time zone, by its IANA name.
///
/// A repeating event needs one: the rule is expanded *in* a zone, and without
/// it a weekly meeting at nine would wander by an hour when the clocks change.
/// Google refuses to create a series without it, which is the right refusal.
pub(crate) fn local_timezone() -> String {
    zone_name(
        std::env::var("TZ").ok(),
        std::fs::read_link("/etc/localtime").ok(),
        iana_time_zone::get_timezone().ok(),
    )
}

/// The first IANA name among the candidates: `TZ`, the zone file
/// `/etc/localtime` points at, and the platform's own answer. Windows has
/// neither of the first two, and returned "UTC" here, so a Google series
/// written there moved an hour at every clock change. A `TZ` in POSIX form
/// (`CET-1CEST`) is not a name Google accepts and is passed over.
fn zone_name(
    tz: Option<String>,
    localtime: Option<std::path::PathBuf>,
    platform: Option<String>,
) -> String {
    let from_tz = tz.map(|name| name.trim_start_matches(':').trim().to_string());
    let from_file = localtime.and_then(|target| {
        let path = target.to_string_lossy().into_owned();
        path.find("zoneinfo/")
            .map(|index| path[index + "zoneinfo/".len()..].to_string())
    });
    [from_tz, from_file, platform]
        .into_iter()
        .flatten()
        .find(|name| !name.is_empty() && name.parse::<chrono_tz::Tz>().is_ok())
        // Not knowing is survivable: UTC is a real zone, and the instants are
        // right either way; only the expansion of a rule across a clock
        // change would differ.
        .unwrap_or_else(|| "UTC".to_string())
}

/// The request body for a create or update.
fn event_body(event: &Event, with_rule: bool) -> Result<serde_json::Value> {
    // Both keys are always sent, the unused one as null.
    //
    // An update is a PATCH, so anything left out keeps the value the server
    // already holds: sending only `dateTime` on an event stored as all-day
    // left `date` in place beside it, and a time that is both a date and an
    // instant is no time at all — which is exactly what Google answers.
    // Naming the unused one as null is what clears it.
    let zone = local_timezone();
    let (start, end) = if event.all_day {
        (
            serde_json::json!({
                "date": date_only(event.start).context("start date")?,
                "dateTime": serde_json::Value::Null,
            }),
            serde_json::json!({
                "date": date_only(event.end).context("end date")?,
                "dateTime": serde_json::Value::Null,
            }),
        )
    } else {
        (
            serde_json::json!({
                "dateTime": rfc3339(event.start).context("start")?,
                "date": serde_json::Value::Null,
                // The instant is already fixed by the offset in `dateTime`;
                // the zone is what a recurrence is expanded in.
                "timeZone": zone,
            }),
            serde_json::json!({
                "dateTime": rfc3339(event.end).context("end")?,
                "date": serde_json::Value::Null,
                "timeZone": zone,
            }),
        )
    };
    let mut body = serde_json::json!({
        "summary": event.subject,
        "location": event.location.clone().unwrap_or_default(),
        "description": event.description,
        // Only those with an address: an attendee named without one cannot be
        // invited, and sending the list without them would uninvite them.
        "attendees": event
            .attendees
            .iter()
            .filter(|person| !person.addr.trim().is_empty())
            .map(|person| serde_json::json!({ "email": person.addr }))
            .collect::<Vec<_>>(),
        "start": start,
        "end": end,
        // Explicit either way: sending overrides when there is a reminder, and
        // an empty override list when there is none, so removing a reminder
        // actually removes it rather than falling back to the calendar's.
        "reminders": match event.reminder_minutes {
            Some(minutes) => serde_json::json!({
                "useDefault": false,
                "overrides": [{ "method": "popup", "minutes": minutes }],
            }),
            None => serde_json::json!({ "useDefault": false, "overrides": [] }),
        },
    });
    // A rule is sent only when there is one to send. This is a PATCH: a null
    // here cleared the series' rule whenever the editor had not loaded it,
    // turning a series into its first occurrence.
    if with_rule {
        if let Some(line) = event.recurrence.as_ref().and_then(|rule| rrule(rule, event.start, event.all_day)) {
            body["recurrence"] = serde_json::json!([line]);
        }
    }
    Ok(body)
}

/// Who is on an event, and its notes.
///
/// Google's window already carries both; reading the event again keeps the
/// caller from having to know that, and costs one request when an event is
/// opened.
pub fn event_details(
    token: &str,
    calendar_id: &str,
    event_id: &str,
) -> Result<(Vec<super::Participant>, String)> {
    let url = format!(
        "{API}/calendars/{}/events/{}",
        urlencode(calendar_id),
        urlencode(event_id),
    );
    let source: GoogleEvent =
        serde_json::from_str(&call(token, "GET", &url, None)?).context("read event")?;
    let description = source
        .description
        .as_deref()
        .map(super::plain_notes)
        .unwrap_or_default();
    let attendees = source
        .attendees
        .iter()
        .map(|attendee| super::Participant {
            name: attendee.display_name.clone().unwrap_or_default(),
            addr: attendee.email.clone().unwrap_or_default(),
            response: attendee.response_status.clone().unwrap_or_default(),
        })
        .collect();
    Ok((attendees, description))
}

/// The rule behind a series, read from its master.
///
/// An expanded instance does not carry the rule — only the id of the master it
/// came from — so showing a reader what their series does takes one request.
pub fn series_rule(token: &str, calendar_id: &str, series_id: &str) -> Result<Option<super::Recurrence>> {
    #[derive(Deserialize)]
    struct Master {
        #[serde(default)]
        recurrence: Vec<String>,
    }
    let url = format!(
        "{API}/calendars/{}/events/{}",
        urlencode(calendar_id),
        urlencode(series_id),
    );
    let master: Master =
        serde_json::from_str(&call(token, "GET", &url, None)?).context("parse series")?;
    Ok(master
        .recurrence
        .iter()
        .find(|line| line.trim_start().to_uppercase().starts_with("RRULE"))
        .and_then(|line| parse_rrule(line)))
}

/// One RRULE line as this codebase's own rule.
///
/// Reading a rule is not expanding one: the occurrences still come from the
/// server. This only has to say back what the reader set, so a rule using
/// parts this client cannot show — BYSETPOS and the rest — is reported as none
/// rather than as a rule it would misrepresent.
fn parse_rrule(line: &str) -> Option<super::Recurrence> {
    use super::{Frequency, Recurrence};
    let body = line.trim().trim_start_matches("RRULE:").trim_start_matches("RRULE");
    let mut freq = None;
    let mut interval = 1u16;
    let mut weekdays = Vec::new();
    let mut until = None;
    let mut count = None;

    for part in body.split(';') {
        let (name, value) = match part.split_once('=') {
            Some(pair) => pair,
            None => continue,
        };
        match name.trim().to_uppercase().as_str() {
            "FREQ" => {
                freq = match value.trim().to_uppercase().as_str() {
                    "DAILY" => Some(Frequency::Daily),
                    "WEEKLY" => Some(Frequency::Weekly),
                    "MONTHLY" => Some(Frequency::Monthly),
                    "YEARLY" => Some(Frequency::Yearly),
                    _ => None,
                }
            }
            "INTERVAL" => interval = value.trim().parse().unwrap_or(1),
            "BYDAY" => {
                weekdays = value
                    .split(',')
                    .filter_map(|day| {
                        // A day may carry an ordinal ("2TU"); this client shows
                        // plain weekdays only, and the ordinal is dropped
                        // rather than pretended away.
                        let code = day.trim().trim_start_matches(|c: char| {
                            c.is_ascii_digit() || c == '-' || c == '+'
                        });
                        Recurrence::RRULE_DAYS
                            .iter()
                            .position(|known| known.eq_ignore_ascii_case(code))
                            .map(|index| index as u8)
                    })
                    .collect()
            }
            "UNTIL" => until = parse_until(value.trim()),
            "COUNT" => count = value.trim().parse().ok(),
            _ => {}
        }
    }

    Some(Recurrence {
        freq: freq?,
        interval: interval.max(1),
        weekdays,
        until,
        count, month_week: None, month_day: None,
    })
}

/// An RRULE `UNTIL`, in either of the two shapes it takes.
fn parse_until(text: &str) -> Option<i64> {
    if let Ok(instant) = chrono::NaiveDateTime::parse_from_str(text, "%Y%m%dT%H%M%SZ") {
        return Some(instant.and_utc().timestamp());
    }
    chrono::NaiveDate::parse_from_str(text, "%Y%m%d")
        .ok()?
        .and_hms_opt(23, 59, 0)
        .map(|naive| naive.and_utc().timestamp())
}

/// The RRULE a rule becomes, anchored on the event's own start.
///
/// One line of iCalendar, which is what Google stores; the server expands it
/// and hands back occurrences, so this is the only direction a rule travels.
pub(crate) fn rrule(rule: &super::Recurrence, start: i64, all_day: bool) -> Option<String> {
    use super::{Frequency, Recurrence as Rule};
    let mut parts = vec![match rule.freq {
        Frequency::Daily => "FREQ=DAILY".to_string(),
        Frequency::Weekly => "FREQ=WEEKLY".to_string(),
        Frequency::Monthly => "FREQ=MONTHLY".to_string(),
        Frequency::Yearly => "FREQ=YEARLY".to_string(),
    }];
    let interval = rule.interval.max(1);
    if interval > 1 {
        parts.push(format!("INTERVAL={interval}"));
    }
    if rule.freq == Frequency::Weekly {
        parts.push(format!(
            "BYDAY={}",
            rule.days_or_start(start, all_day)
                .into_iter()
                .map(|day| Rule::RRULE_DAYS[day as usize])
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    // As with Exchange: a date the reader picked wins over a count.
    match (rule.until, rule.count) {
        (Some(until), _) => {
            // UNTIL is inclusive and compared against the whole instant, so it
            // is set to the end of that day — otherwise a series "until the
            // 30th" stops on the 29th.
            // The editor stores the end date as the last minute of that
            // day on this machine's clock.
            let end = super::start_date(until, false)?;
            parts.push(format!("UNTIL={}", end.format("%Y%m%dT235959Z")));
        }
        (None, Some(count)) => parts.push(format!("COUNT={}", count.max(1))),
        (None, None) => {}
    }
    Some(format!("RRULE:{}", parts.join(";")))
}

/// One API event as this codebase's own. `None` for an entry with no usable
/// instant: an event that cannot be placed on a calendar is not one.
fn to_event(source: GoogleEvent, calendar_id: &str) -> Option<Event> {
    let start_field = source.start.as_ref()?;
    let all_day = start_field.date.is_some();
    let start = instant(start_field)?;
    let end = source.end.as_ref().and_then(instant).unwrap_or(start);

    let organizer = source.organizer.as_ref().map(|person| Participant {
        name: person.display_name.clone().unwrap_or_default(),
        addr: person.email.clone().unwrap_or_default(),
        response: String::new(),
    });
    let my_response = source
        .attendees
        .iter()
        .find(|attendee| attendee.is_self)
        .and_then(|attendee| attendee.response_status.clone())
        .unwrap_or_default();
    let attendees = source
        .attendees
        .iter()
        .map(|attendee| Participant {
            name: attendee.display_name.clone().unwrap_or_default(),
            addr: attendee.email.clone().unwrap_or_default(),
            response: attendee.response_status.clone().unwrap_or_default(),
        })
        .collect();

    let (meeting, _) = google_meeting(source.conference_data.as_ref(), source.hangout_link.as_deref());
    Some(Event {
        meeting,
        add_meeting: None,
        meeting_status: None,
        floating: None,
        id: source.id,
        calendar_id: calendar_id.to_string(),
        change_key: source.etag,
        subject: source.summary.unwrap_or_default(),
        location: source.location,
        start,
        end,
        all_day,
        // With `singleEvents=true` an instance of a series carries the id of
        // the series it belongs to; a one-off carries none.
        is_recurring: source.recurring_event_id.is_some(),
        series_id: source.recurring_event_id.clone(),
        recurrence: None,
        description: source
            .description
            .as_deref()
            .map(super::plain_notes)
            .unwrap_or_default(),
        reminder_minutes: source.reminders.as_ref().and_then(|reminders| {
            if reminders.use_default && reminders.overrides.is_empty() {
                return None;
            }
            reminders
                .overrides
                .iter()
                .find_map(|entry| entry.minutes)
        }),
        is_cancelled: source.status == "cancelled",
        free_busy: match source.transparency.as_deref() {
            Some("transparent") => "free".to_string(),
            _ => "busy".to_string(),
        },
        my_response,
        organizer,
        attendees,
    })
}

/// The instant a start or end refers to, as epoch seconds.
fn instant(value: &EventDateTime) -> Option<i64> {
    if let Some(text) = &value.date_time {
        return chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|parsed| parsed.timestamp());
    }
    // An all-day event carries a calendar date and no zone. UTC midnight is
    // the only reading available here, and is what the subscribed-calendar
    // path already uses, so the two agree.
    let date = value.date.as_ref()?;
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)
        .map(|naive| naive.and_utc().timestamp())
}

fn rfc3339(epoch_seconds: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(epoch_seconds, 0).map(|instant| instant.to_rfc3339())
}

fn date_only(epoch_seconds: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(epoch_seconds, 0)
        .map(|instant| instant.format("%Y-%m-%d").to_string())
}

/// Percent-encodes a path or query component. Calendar ids are email-shaped
/// and event ids are opaque, so neither can be pasted into a URL raw.
fn urlencode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One request as the local server saw it.
    #[derive(Debug, Clone)]
    struct Seen {
        method: String,
        path: String,
        if_match: Option<String>,
        body: String,
    }

    /// Answers the given responses in order, one per connection, from a
    /// loopback server, and points this thread's client at it.
    fn serve(responses: Vec<(u16, String)>) -> std::sync::Arc<std::sync::Mutex<Vec<Seen>>> {
        use std::io::{BufRead as _, BufReader, Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/calendar/v3", listener.local_addr().unwrap());
        TEST_BASE.with(|slot| *slot.borrow_mut() = Some(base));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = seen.clone();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let Ok((stream, _)) = listener.accept() else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let (mut length, mut if_match) = (0usize, None);
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    let (name, value) = header.split_once(':').unwrap();
                    match name.to_ascii_lowercase().as_str() {
                        "content-length" => length = value.trim().parse().unwrap(),
                        "if-match" => if_match = Some(value.trim().to_string()),
                        _ => {}
                    }
                }
                let mut content = vec![0; length];
                reader.read_exact(&mut content).unwrap();
                record.lock().unwrap().push(Seen {
                    method,
                    path,
                    if_match,
                    body: String::from_utf8(content).unwrap(),
                });
                let mut stream = stream;
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        seen
    }

    fn stored(change_key: Option<&str>, series: Option<&str>) -> Event {
        Event {
            id: "occurrence-1".into(),
            calendar_id: "primary".into(),
            change_key: change_key.map(str::to_string),
            subject: "Review".into(),
            location: None,
            start: 1_791_799_200,
            end: 1_791_802_800,
            all_day: false,
            is_recurring: series.is_some(),
            series_id: series.map(str::to_string),
            recurrence: None,
            description: String::new(),
            reminder_minutes: None,
            is_cancelled: false,
            free_busy: String::new(),
            my_response: String::new(),
            organizer: None,
            attendees: Vec::new(),
            meeting: None,
            add_meeting: None,
            meeting_status: None,
            floating: None,
        }
    }

    #[test]
    fn a_meet_is_created_with_the_event_only_when_asked_and_bound_to_it() {
        let seen = serve(vec![(
            200,
            r#"{"id":"ev1","etag":"\"v1\"","hangoutLink":"https://meet.google.com/abc-defg-hij",
                "conferenceData":{"entryPoints":[{"entryPointType":"video","uri":"https://meet.google.com/abc-defg-hij"},
                {"entryPointType":"phone","uri":"tel:+1-555"}],"conferenceSolution":{"key":{"type":"hangoutsMeet"}},
                "createRequest":{"status":{"statusCode":"success"}}}}"#
                .into(),
        )]);
        let mut event = stored(None, None);
        event.id = String::new();
        event.add_meeting = Some("meet".into());
        let created = create_event("token", &event, false).unwrap();
        assert_eq!(
            created.meeting,
            Some(super::super::meeting::Meeting { provider: "meet".into(), url: "https://meet.google.com/abc-defg-hij".into() })
        );
        assert_eq!(created.meeting_status.as_deref(), Some("ready"));
        let seen = seen.lock().unwrap();
        assert!(seen[0].path.contains("conferenceDataVersion=1"), "{}", seen[0].path);
        let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
        let request = &body["conferenceData"]["createRequest"];
        assert_eq!(request["conferenceSolutionKey"]["type"], "hangoutsMeet");
        // Retrying the same save asks for the same meeting.
        assert_eq!(request["requestId"], super::super::meeting::request_id("primary", &meeting_key(&event)));

        // Not asked: nothing about meetings is sent.
        drop(seen);
        let seen = serve(vec![(200, r#"{"id":"ev2"}"#.into())]);
        let plain = create_event("token", &stored(None, None), false).unwrap();
        assert_eq!(plain.meeting_status, None);
        let seen = seen.lock().unwrap();
        assert!(!seen[0].path.contains("conferenceDataVersion"));
        assert!(!seen[0].body.contains("conferenceData"));
    }

    #[test]
    fn a_meet_google_cannot_make_is_said_not_assumed() {
        let _seen = serve(vec![(
            200,
            r#"{"id":"ev1","conferenceData":{"createRequest":{"status":{"statusCode":"failure"}}}}"#.into(),
        )]);
        let mut event = stored(None, None);
        event.add_meeting = Some("meet".into());
        let created = create_event("token", &event, false).unwrap();
        assert_eq!(created.meeting, None);
        assert_eq!(created.meeting_status.as_deref(), Some("failed"));

        let _seen = serve(vec![(
            200,
            r#"{"id":"ev1","conferenceData":{"createRequest":{"status":{"statusCode":"pending"}}}}"#.into(),
        )]);
        assert_eq!(create_event("token", &event, false).unwrap().meeting_status.as_deref(), Some("pending"));
    }

    #[test]
    fn an_edit_keeps_the_meeting_adds_one_once_or_removes_it_when_asked() {
        // Keeps: a plain edit sends nothing about it, and PATCH leaves it.
        let seen = serve(vec![(200, r#"{"etag":"\"v2\""}"#.into())]);
        let mut event = stored(Some("\"v1\""), None);
        event.meeting = Some(super::super::meeting::Meeting { provider: "meet".into(), url: "https://meet.google.com/x".into() });
        update_event("token", &event, false, false).unwrap();
        assert!(!seen.lock().unwrap()[0].body.contains("conferenceData"));

        // Asking for a Meet on an event that has one makes no second one.
        let seen = serve(vec![(200, r#"{"etag":"\"v3\""}"#.into())]);
        event.add_meeting = Some("meet".into());
        update_event("token", &event, false, false).unwrap();
        assert!(!seen.lock().unwrap()[0].body.contains("conferenceData"));

        // Removing it sends null, with the version that makes Google read it.
        let seen = serve(vec![(200, r#"{"etag":"\"v4\""}"#.into())]);
        event.add_meeting = Some("none".into());
        update_event("token", &event, false, false).unwrap();
        let seen = seen.lock().unwrap();
        assert!(seen[0].path.contains("conferenceDataVersion=1"));
        let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
        assert!(body["conferenceData"].is_null() && body.as_object().unwrap().contains_key("conferenceData"));

        // Another kind is refused before anything is sent.
        event.add_meeting = Some("zoom".into());
        assert!(update_event("token", &event, false, false).is_err());
    }

    #[test]
    fn an_add_on_meeting_google_holds_is_named_by_its_address() {
        let data: ConferenceData = serde_json::from_str(
            r#"{"entryPoints":[{"entryPointType":"video","uri":"https://us02web.zoom.us/j/81234"}],
                "conferenceSolution":{"key":{"type":"addOn"}}}"#,
        )
        .unwrap();
        let (meeting, _) = google_meeting(Some(&data), None);
        assert_eq!(meeting.unwrap().provider, "zoom");
    }

    #[test]
    fn an_edit_is_sent_with_the_version_it_was_read_at() {
        let seen = serve(vec![(200, r#"{"id":"occurrence-1","etag":"\"v2\""}"#.into())]);
        let version = update_event("token", &stored(Some("\"v1\""), None), false, false).unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].method, "PATCH");
        assert_eq!(seen[0].if_match.as_deref(), Some("\"v1\""));
        assert_eq!(version.as_deref(), Some("\"v2\""), "the new version is reported back");
    }

    #[test]
    fn an_edit_made_elsewhere_in_between_is_not_overwritten() {
        let _seen = serve(vec![(412, r#"{"error":{"message":"Precondition Failed"}}"#.into())]);
        let err = update_event("token", &stored(Some("\"v1\""), None), false, false).unwrap_err();
        assert!(format!("{err:#}").contains("changed elsewhere"), "{err:#}");
    }

    #[test]
    fn a_series_edit_does_not_claim_the_occurrences_version_for_the_master() {
        let seen = serve(vec![
            (200, r#"{"etag":"\"master\"","start":{"dateTime":"2026-10-05T09:00:00Z"}}"#.into()),
            (200, r#"{"id":"master"}"#.into()),
        ]);
        update_event("token", &stored(Some("\"occurrence\""), Some("master")), true, false).unwrap();
        let seen = seen.lock().unwrap();
        assert!(seen[1].path.contains("/events/master"));
        assert_eq!(seen[1].if_match.as_deref(), Some("\"master\""), "the master's own version, never the occurrence's");
    }

    #[test]
    fn a_series_edit_keeps_the_series_first_date_and_its_rule() {
        use chrono::TimeZone as _;
        let local = |y, m, d, h| {
            chrono::Local
                .from_local_datetime(&chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, 0, 0).unwrap())
                .earliest()
                .unwrap()
                .timestamp()
        };
        // The series began on 5 October at 09:00. The occurrence on 19
        // October is edited to 10:00–11:30 and saved for the whole series.
        let master_start = rfc3339(local(2026, 10, 5, 9)).unwrap();
        let seen = serve(vec![
            (200, format!(r#"{{"etag":"\"master-v3\"","start":{{"dateTime":"{master_start}"}}}}"#)),
            (200, r#"{"id":"master","etag":"\"master-v4\""}"#.into()),
        ]);
        let mut occurrence = stored(Some("\"occurrence\""), Some("master"));
        occurrence.start = local(2026, 10, 19, 10);
        occurrence.end = occurrence.start + 90 * 60;
        occurrence.recurrence = None; // the editor had not loaded the rule

        let version = update_event("token", &occurrence, true, false).unwrap();
        assert_eq!(version, None, "the master's version is not the occurrence's");

        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].method, "GET");
        assert!(seen[1].path.contains("/events/master"));
        assert_eq!(seen[1].if_match.as_deref(), Some("\"master-v3\""), "the master is written at the version read");
        let body: serde_json::Value = serde_json::from_str(&seen[1].body).unwrap();
        let start = chrono::DateTime::parse_from_rfc3339(body["start"]["dateTime"].as_str().unwrap()).unwrap();
        let end = chrono::DateTime::parse_from_rfc3339(body["end"]["dateTime"].as_str().unwrap()).unwrap();
        assert_eq!(start.timestamp(), local(2026, 10, 5, 10), "first date kept, new time of day");
        assert_eq!(end.timestamp() - start.timestamp(), 90 * 60);
        assert!(body.get("recurrence").is_none(), "no rule sent means the rule is kept, not cleared");
    }

    #[test]
    fn an_occurrence_edit_never_carries_a_rule() {
        let seen = serve(vec![(200, r#"{"id":"occurrence-1","etag":"\"v2\""}"#.into())]);
        let mut occurrence = stored(Some("\"v1\""), Some("master"));
        occurrence.recurrence = Some(super::super::Recurrence {
            freq: super::super::Frequency::Weekly,
            interval: 1,
            weekdays: vec![1],
            until: None,
            count: None, month_week: None, month_day: None,
        });
        update_event("token", &occurrence, false, false).unwrap();
        let body: serde_json::Value = serde_json::from_str(&seen.lock().unwrap()[0].body).unwrap();
        assert!(body.get("recurrence").is_none());
    }

    #[test]
    fn an_answer_keeps_whoever_joined_while_it_was_being_written() {
        // Read v1 with one attendee; the write is refused because someone was
        // added; read again (v2, two attendees) and write that list.
        let seen = serve(vec![
            (200, r#"{"etag":"\"v1\"","attendees":[{"email":"me@x","self":true}]}"#.into()),
            (412, r#"{"error":{"message":"Precondition Failed"}}"#.into()),
            (200, r#"{"etag":"\"v2\"","attendees":[{"email":"me@x","self":true},{"email":"new@x"}]}"#.into()),
            (200, r#"{}"#.into()),
        ]);
        respond("token", "primary", "event-1", super::super::Response::Accept).unwrap();
        let seen = seen.lock().unwrap();
        let methods: Vec<&str> = seen.iter().map(|request| request.method.as_str()).collect();
        assert_eq!(methods, vec!["GET", "PATCH", "GET", "PATCH"]);
        assert_eq!(seen[1].if_match.as_deref(), Some("\"v1\""));
        assert_eq!(seen[3].if_match.as_deref(), Some("\"v2\""));
        assert!(seen[3].body.contains("new@x"), "the attendee added in between is kept");
        assert!(seen[3].body.contains("\"responseStatus\":\"accepted\""));
    }

    #[test]
    fn a_rule_read_back_says_what_was_written() {
        use super::super::Frequency;
        let rule = parse_rrule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261026T235959Z")
            .expect("a rule this client can show");
        assert_eq!(rule.freq, Frequency::Weekly);
        assert_eq!(rule.interval, 2);
        assert_eq!(rule.weekdays, vec![1, 3]);
        assert!(rule.until.is_some());
        assert!(rule.count.is_none());

        let counted = parse_rrule("FREQ=DAILY;COUNT=10").expect("rule");
        assert_eq!(counted.freq, Frequency::Daily);
        assert_eq!(counted.count, Some(10));
        assert_eq!(counted.interval, 1, "an absent interval is one");

        // An ordinal day is not something this client can draw, so the ordinal
        // is dropped rather than misread as a plain weekday count.
        let ordinal = parse_rrule("FREQ=MONTHLY;BYDAY=2TU").expect("rule");
        assert_eq!(ordinal.weekdays, vec![1]);

        // No frequency is no rule.
        assert!(parse_rrule("RRULE:COUNT=3").is_none());
    }

    #[test]
    fn a_rule_becomes_one_line_of_icalendar() {
        use super::super::{Frequency, Recurrence};
        // Thursday 27 August 2026 at noon on this machine's clock.
        let start = {
            use chrono::TimeZone as _;
            chrono::Local
                .from_local_datetime(
                    &chrono::NaiveDate::from_ymd_opt(2026, 8, 27).unwrap().and_hms_opt(12, 0, 0).unwrap(),
                )
                .earliest()
                .unwrap()
                .timestamp()
        };

        let fortnightly = Recurrence {
            freq: Frequency::Weekly,
            interval: 2,
            weekdays: vec![1, 3],
            // As the editor stores "until 26 October": the last minute of
            // that day on this machine's clock.
            until: Some({
                use chrono::TimeZone as _;
                chrono::Local
                    .from_local_datetime(
                        &chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap().and_hms_opt(23, 59, 0).unwrap(),
                    )
                    .earliest()
                    .unwrap()
                    .timestamp()
            }),
            count: None,
            ..Default::default()
        };
        let line = rrule(&fortnightly, start, false).expect("rrule");
        assert!(line.starts_with("RRULE:FREQ=WEEKLY"), "{line}");
        assert!(line.contains("INTERVAL=2"), "{line}");
        assert!(line.contains("BYDAY=TU,TH"), "{line}");
        // Inclusive to the end of that day, or a series "until the 26th" would
        // stop on the 25th.
        assert!(line.contains("UNTIL=20261026T235959Z"), "{line}");

        // Every day, ten times, with no interval spelled out: one is the
        // default and saying so adds nothing.
        let ten_days = Recurrence {
            freq: Frequency::Daily,
            interval: 1,
            weekdays: vec![],
            until: None,
            count: Some(10), month_week: None, month_day: None,
        };
        let line = rrule(&ten_days, start, false).expect("rrule");
        assert_eq!(line, "RRULE:FREQ=DAILY;COUNT=10");

        // Weekly with no days named falls on the day the event starts.
        let weekly = Recurrence {
            freq: Frequency::Weekly,
            interval: 1,
            weekdays: vec![],
            until: None,
            count: None, month_week: None, month_day: None,
        };
        assert_eq!(rrule(&weekly, start, false).expect("rrule"), "RRULE:FREQ=WEEKLY;BYDAY=TH");
    }

    #[test]
    fn a_rule_falls_on_the_days_and_end_date_the_person_sees() {
        use super::super::{Frequency, Recurrence};
        use chrono::TimeZone as _;
        let local = |y, m, d, h, min| {
            chrono::Local
                .from_local_datetime(
                    &chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, min, 0).unwrap(),
                )
                .earliest()
                .unwrap()
                .timestamp()
        };
        let weekly = |until| Recurrence { freq: Frequency::Weekly, interval: 1, weekdays: vec![], until, count: None, ..Default::default() };
        // Tuesday 13 October 2026 at 00:30 on this machine's clock: east of
        // UTC that is still Monday in UTC, and was saved as every Monday.
        let line = rrule(&weekly(None), local(2026, 10, 13, 0, 30), false).unwrap();
        assert_eq!(line, "RRULE:FREQ=WEEKLY;BYDAY=TU");
        // Late on Tuesday: west of UTC that is already Wednesday in UTC.
        let line = rrule(&weekly(None), local(2026, 10, 13, 23, 30), false).unwrap();
        assert_eq!(line, "RRULE:FREQ=WEEKLY;BYDAY=TU");
        // An all-day date is a UTC date already, whatever the machine.
        let tuesday = chrono::DateTime::parse_from_rfc3339("2026-10-13T00:00:00Z").unwrap().timestamp();
        assert_eq!(rrule(&weekly(None), tuesday, true).unwrap(), "RRULE:FREQ=WEEKLY;BYDAY=TU");
        // "Until 30 October" is stored as 23:59 that day on this clock.
        let line = rrule(&weekly(Some(local(2026, 10, 30, 23, 59))), tuesday, true).unwrap();
        assert!(line.ends_with("UNTIL=20261030T235959Z"), "{line}");
    }

    #[test]
    fn the_zone_a_series_is_written_in_is_an_iana_name() {
        let path = |p: &str| Some(std::path::PathBuf::from(p));
        let name = |n: &str| Some(n.to_string());
        assert_eq!(zone_name(name(":Europe/Madrid"), None, None), "Europe/Madrid");
        assert_eq!(zone_name(None, path("/usr/share/zoneinfo/Asia/Tokyo"), None), "Asia/Tokyo");
        // Windows: no TZ, no zone file; the platform answers.
        assert_eq!(zone_name(None, None, name("Europe/Berlin")), "Europe/Berlin");
        // A POSIX TZ is passed over for the next candidate.
        assert_eq!(zone_name(name("CET-1CEST"), None, name("Europe/Paris")), "Europe/Paris");
        assert_eq!(zone_name(None, None, None), "UTC");
    }

    #[test]
    fn a_write_clears_the_kind_of_time_it_is_not() {
        let timed = Event {
            start: 1_788_249_600,
            end: 1_788_253_200,
            all_day: false,
            ..Default::default()
        };
        let body = event_body(&timed, true).expect("body");
        assert!(body["start"]["dateTime"].is_string());
        assert!(
            body["start"]["timeZone"].is_string(),
            "a rule is expanded in a zone, so a timed event names one"
        );
        assert!(
            body["start"]["date"].is_null(),
            "an update is a PATCH: the date must be cleared, not merely omitted"
        );

        let all_day = Event {
            all_day: true,
            ..timed
        };
        let body = event_body(&all_day, true).expect("body");
        assert!(body["start"]["date"].is_string());
        assert!(body["start"]["dateTime"].is_null());
        assert!(body["end"]["dateTime"].is_null());
    }

    #[test]
    fn a_timed_event_keeps_its_instant_and_its_people() {
        let source: GoogleEvent = serde_json::from_str(
            r#"{
              "id": "abc_20260901T080000Z",
              "etag": "\"123\"",
              "status": "confirmed",
              "summary": "Reunió equip",
              "location": "Sala 2",
              "start": {"dateTime": "2026-09-01T10:00:00+02:00"},
              "end": {"dateTime": "2026-09-01T11:30:00+02:00"},
              "recurringEventId": "abc",
              "organizer": {"email": "cap@example.org", "displayName": "La Cap"},
              "attendees": [
                {"email": "jo@example.org", "responseStatus": "accepted", "self": true},
                {"email": "altre@example.org", "responseStatus": "needsAction"}
              ]
            }"#,
        )
        .expect("the wire type should parse");
        let event = to_event(source, "cal").expect("a dated event maps");

        let expected = chrono::DateTime::parse_from_rfc3339("2026-09-01T08:00:00Z")
            .unwrap()
            .timestamp();
        assert_eq!(event.start, expected, "10:00 in +02:00 is 08:00 UTC");
        assert_eq!(event.end - event.start, 90 * 60);
        assert!(!event.all_day);
        assert!(event.is_recurring, "an instance names the series it came from");
        assert_eq!(event.my_response, "accepted", "this mailbox's own answer");
        assert_eq!(event.attendees.len(), 2);
        assert_eq!(event.organizer.as_ref().unwrap().name, "La Cap");
        assert_eq!(event.free_busy, "busy", "the same words as Exchange");
    }

    #[test]
    fn an_events_notes_come_along() {
        let source: GoogleEvent = serde_json::from_str(
            r#"{"id":"x","status":"confirmed","summary":"Revisió",
                "description":"Portar el portàtil.\nSala reservada fins les 12.",
                "start":{"dateTime":"2026-09-01T10:00:00Z"},
                "end":{"dateTime":"2026-09-01T11:00:00Z"}}"#,
        )
        .expect("parse");
        let event = to_event(source, "cal").expect("map");
        assert!(event.description.contains("portàtil"));
        assert!(
            event.description.contains('\n'),
            "the author's own line breaks survive"
        );
    }

    #[test]
    fn an_all_day_event_is_a_date_not_an_instant() {
        let source: GoogleEvent = serde_json::from_str(
            r#"{"id":"x","status":"confirmed","summary":"Festiu",
                "start":{"date":"2026-09-11"},"end":{"date":"2026-09-12"}}"#,
        )
        .expect("parse");
        let event = to_event(source, "cal").expect("map");
        assert!(event.all_day);
        assert_eq!(event.end - event.start, 24 * 3600);
        assert!(!event.is_recurring, "a one-off names no series");
    }

    #[test]
    fn an_entry_with_no_start_cannot_be_placed_on_a_calendar() {
        let source: GoogleEvent =
            serde_json::from_str(r#"{"id":"x","status":"confirmed","summary":"Sense data"}"#)
                .expect("parse");
        assert!(to_event(source, "cal").is_none());
    }

    #[test]
    fn a_calendar_someone_else_owns_is_read_only() {
        let list: CalendarList = serde_json::from_str(
            r##"{"items":[
                 {"id":"me@gmail.com","summary":"Personal","primary":true,"accessRole":"owner",
                  "backgroundColor":"#9fe1e7"},
                 {"id":"team@group.calendar.google.com","summary":"Equip","accessRole":"reader"},
                 {"id":"gone@x","summary":"Fora","accessRole":"owner","deleted":true}
               ]}"##,
        )
        .expect("parse");
        // Exercised through the same mapping the request path uses.
        let calendars: Vec<Calendar> = list
            .items
            .into_iter()
            .filter(|entry| !entry.deleted)
            .map(|entry| Calendar {
                id: entry.id,
                name: entry.summary,
                is_default: entry.primary,
                read_only: !matches!(entry.access_role.as_str(), "owner" | "writer"),
                color: entry.background_color,
                ..Default::default()
            })
            .collect();

        assert_eq!(calendars.len(), 2, "a calendar removed from the list is gone");
        assert!(calendars[0].is_default && !calendars[0].read_only);
        assert_eq!(
            calendars[0].color.as_deref(),
            Some("#9fe1e7"),
            "the colour Google draws it in comes along"
        );
        assert!(calendars[1].read_only, "reader access cannot be edited");
    }

    #[test]
    fn ids_are_escaped_before_they_reach_a_url() {
        // Calendar ids are email-shaped and event ids can carry anything.
        assert_eq!(urlencode("me@gmail.com"), "me%40gmail.com");
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencode("plain-id_1.2~3"), "plain-id_1.2~3");
    }

    #[test]
    fn a_token_without_calendar_permission_says_what_to_do_about_it() {
        // The account works and its calendar does not; nothing the user can
        // see explains that, so the message names the fix rather than the
        // protocol.
        let body = r#"{"error":{"code":403,"message":"Request had insufficient authentication scopes."}}"#;
        let told = explain(403, body);
        assert!(told.contains("reconnect"), "got: {told}");
        assert!(!told.contains("403"), "the status code is not the point");

        // Anything else is reported as what it was.
        let other = explain(404, r#"{"error":{"code":404,"message":"Not Found"}}"#);
        assert!(other.contains("404") && other.contains("Not Found"));
    }

    #[test]
    fn an_error_body_is_reported_by_its_sentence() {
        let body = r#"{"error":{"code":403,"message":"Request had insufficient authentication scopes."}}"#;
        assert_eq!(brief(body), "Request had insufficient authentication scopes.");
        // A body that is not the usual envelope still says something.
        assert!(brief("<html>502</html>").contains("502"));
    }
}
