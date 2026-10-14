//! The address-book commands: `people.list`, `people.save` and
//! `people.delete`, on the local book and on CardDAV books (ADR-0012).

use std::sync::Arc;

use anyhow::{Context as _, Result};
use serde_json::{json, Value};

use super::{req_str, req_u32};
use crate::engine::Engine;
use crate::store::{self, now_unix};


/// People, from whichever books have been brought in. An empty query is the
/// whole book, which is what the Personas view opens on.
pub fn list(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let query = req_str(p, "query").unwrap_or_default();
    let limit = req_u32(p, "limit").unwrap_or(500);
    let (found, writable, links) = {
        let db = engine.db.lock().unwrap();
        (
            store::find_people(&db, &query, limit)?,
            store::contact_sources_writable(&db)?,
            store::person_links::links(&db)?,
        )
    };
    Ok(json!({
        "people": found
            .iter()
            .map(|stored| json!({
                "id": stored.id,
                "source": stored.origin.source,
                "account": stored.origin.account,
                "book": stored.origin.book,
                "name": stored.person.name,
                "given": stored.person.given,
                "family": stored.person.family,
                "organisation": stored.person.organisation,
                "note": stored.person.note,
                "photo": stored.photo_key,
                "emails": stored.person.emails,
                "phones": stored.person.phones,
                "version": stored.version,
                // Linked by the reader with the same person elsewhere.
                "link": links.get(&stored.id),
                // The local book, and CardDAV books the server has not
                // said are read-only (ADR-0012). Google and Exchange
                // stay read-only here.
                "editable": stored.origin.source == "local"
                    || (stored.origin.source == "carddav"
                        && writable.get(&stored.origin.book).copied().flatten() != Some(false)),
            }))
            .collect::<Vec<_>>()
    }))
}

/// Creates a person in the local book (or, with `book`, a CardDAV one), or
/// edits one from the version it was read at. A different version saves
/// nothing and answers with the copy that is there now, for the reader to
/// choose (ADR-0012).
pub async fn save(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let id = p.get("id").and_then(Value::as_str).filter(|id| !id.is_empty());
    let version = p.get("version").and_then(Value::as_str);
    if id.is_some() && version.is_none() {
        anyhow::bail!("an edit must say which version it was made from");
    }
    let input: PersonInput =
        serde_json::from_value(p.get("person").cloned().context("missing param: person")?)
            .context("person")?;
    let stored = match id {
        Some(id) => store::synced_person(&engine.db.lock().unwrap(), id)?,
        None => None,
    };
    // An editor that does not know about given and family names (an older
    // window, the phone) leaves them as they were rather than clearing them.
    let mut person = input.into_person();
    if let Some(stored) = &stored {
        if person.given_unset {
            person.person.given = stored.person.given.clone();
        }
        if person.family_unset {
            person.person.family = stored.person.family.clone();
        }
    }
    let person = person.person;
    let book = p.get("book").and_then(Value::as_str).filter(|book| !book.is_empty() && *book != "local");
    match (&stored, book) {
        (Some(stored), _) if stored.origin.source == "carddav" => {
            carddav_save(&engine, Some(stored), version.unwrap_or_default(), person).await
        }
        (Some(stored), _) if stored.origin.source != "local" => {
            anyhow::bail!("this address book is read-only here")
        }
        (None, Some(book)) if id.is_none() => {
            let source = store::contact_source(&engine.db.lock().unwrap(), book)?
                .context("that address book is no longer set up")?;
            if source.kind != "carddav" {
                anyhow::bail!("this address book is read-only here");
            }
            carddav_create(&engine, &source, person).await
        }
        _ => {
            let write =
                store::local_people::save(&engine.db.lock().unwrap(), id, version, &person, now_unix())?;
            Ok(local_write_json(write))
        }
    }
}

/// Deletes a person from the version it was read at.
pub async fn delete(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let id = req_str(p, "id")?;
    let version = req_str(p, "version")?;
    let stored = store::synced_person(&engine.db.lock().unwrap(), &id)?;
    match stored {
        Some(stored) if stored.origin.source == "carddav" => carddav_delete(&engine, &id, &stored, &version).await,
        Some(stored) if stored.origin.source != "local" => anyhow::bail!("this address book is read-only here"),
        _ => {
            let write = store::local_people::delete(&engine.db.lock().unwrap(), &id, &version)?;
            Ok(local_write_json(write))
        }
    }
}

/// The source a CardDAV contact belongs to, and a transport signed in to it.
fn carddav_target(
    engine: &Engine,
    book: &str,
) -> Result<(store::ContactSource, crate::carddav::http::UreqTransport)> {
    let source = {
        let db = engine.db.lock().unwrap();
        if store::contact_sources_writable(&db)?.get(book).copied().flatten() == Some(false) {
            anyhow::bail!("the server says this address book is read-only for this account");
        }
        store::contact_source(&db, book)?.context("that address book is no longer set up")?
    };
    let password = crate::secrets::load(&source.id).map(|secrets| secrets.password).unwrap_or_default();
    let proxy = store::account_proxy(&engine.db.lock().unwrap(), &source.account)?;
    let transport = crate::carddav::http::UreqTransport { username: source.username.clone(), password, proxy };
    Ok((source, transport))
}

/// Edits a CardDAV contact from the version it was read at (ADR-0012).
async fn carddav_save(
    engine: &Arc<Engine>,
    stored: Option<&store::SyncedPerson>,
    read_at: &str,
    person: crate::contacts::person::Person,
) -> Result<Value> {
    let stored = stored.context("no such contact")?.clone();
    if stored.href.is_empty() {
        anyhow::bail!("this contact's place on the server is not known yet; sync the address book and try again");
    }
    let (source, transport) = carddav_target(engine, &stored.origin.book)?;
    let read_at = read_at.to_string();
    let now = now_unix();
    let (book_url, href, uid) = (source.url.clone(), stored.href.clone(), stored.person.uid.clone());
    let outcome = tokio::task::spawn_blocking(move || {
        crate::carddav::write::save_existing(&transport, &book_url, &href, &read_at, &uid, &person, now)
    })
    .await??;
    record_carddav_outcome(engine, &stored.origin, outcome, Some(&stored.origin.person_id(&stored.person.uid)))
}

/// Creates a person in a CardDAV book.
pub async fn carddav_create(
    engine: &Arc<Engine>,
    source: &store::ContactSource,
    person: crate::contacts::person::Person,
) -> Result<Value> {
    let (source, transport) = carddav_target(engine, &source.id)?;
    let book_url = source.url.clone();
    let outcome =
        tokio::task::spawn_blocking(move || crate::carddav::write::save_new(&transport, &book_url, &person)).await??;
    let origin = store::BookOrigin { source: source.kind.clone(), account: source.account.clone(), book: source.id.clone() };
    record_carddav_outcome(engine, &origin, outcome, None)
}

async fn carddav_delete(
    engine: &Arc<Engine>,
    id: &str,
    stored: &store::SyncedPerson,
    read_at: &str,
) -> Result<Value> {
    if stored.href.is_empty() {
        anyhow::bail!("this contact's place on the server is not known yet; sync the address book and try again");
    }
    let (source, transport) = carddav_target(engine, &stored.origin.book)?;
    let (book_url, href, read_at) = (source.url.clone(), stored.href.clone(), read_at.to_string());
    let outcome = tokio::task::spawn_blocking(move || {
        crate::carddav::write::delete_existing(&transport, &book_url, &href, &read_at)
    })
    .await??;
    record_carddav_outcome(engine, &stored.origin, outcome, Some(id))
}

/// Brings the local copy in line with what the server now holds, and answers
/// the editor in the same shape as the local book does.
fn record_carddav_outcome(
    engine: &Engine,
    origin: &store::BookOrigin,
    outcome: crate::carddav::write::Outcome,
    id: Option<&str>,
) -> Result<Value> {
    use crate::carddav::write::Outcome;
    let db = engine.db.lock().unwrap();
    match outcome {
        Outcome::Saved { href, version, person } => {
            let id = store::put_synced_person(
                &db,
                origin,
                &store::SyncedRow { person, photo_key: String::new(), href, version: version.clone() },
                now_unix(),
            )?;
            Ok(json!({ "ok": true, "id": id, "version": version }))
        }
        Outcome::Deleted => {
            if let Some(id) = id {
                store::forget_person(&db, id)?;
            }
            Ok(json!({ "ok": true }))
        }
        Outcome::Conflict { current } => Ok(json!({
            "ok": false,
            "conflict": true,
            "current": current.map(|(person, version)| json!({
                "id": id.unwrap_or_default(),
                "name": person.name,
                "given": person.given,
                "family": person.family,
                "organisation": person.organisation,
                "note": person.note,
                "emails": person.emails,
                "phones": person.phones,
                "version": version,
            })),
        })),
    }
}

/// A person as the editor sends it: any field may be left out.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct PersonInput {
    name: String,
    given: Option<String>,
    family: Option<String>,
    organisation: String,
    note: String,
    emails: Vec<LabelledInput>,
    phones: Vec<LabelledInput>,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct LabelledInput {
    #[serde(alias = "number")]
    addr: String,
    label: String,
}

/// A person from the editor, saying which name parts it did not send.
struct EditedPerson {
    person: crate::contacts::person::Person,
    given_unset: bool,
    family_unset: bool,
}

impl PersonInput {
    fn into_person(self) -> EditedPerson {
        use crate::contacts::person::{EmailAddress, Person, PhoneNumber};
        let (given_unset, family_unset) = (self.given.is_none(), self.family.is_none());
        let given = self.given.unwrap_or_default().trim().to_string();
        let family = self.family.unwrap_or_default().trim().to_string();
        // A name typed only as its two parts still has a whole name.
        let name = if self.name.trim().is_empty() {
            [given.as_str(), family.as_str()].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" ")
        } else {
            self.name
        };
        let person = Person {
            name,
            given,
            family,
            organisation: self.organisation,
            note: self.note,
            emails: self.emails.into_iter().map(|e| EmailAddress { addr: e.addr, label: e.label }).collect(),
            phones: self.phones.into_iter().map(|p| PhoneNumber { number: p.addr, label: p.label }).collect(),
            ..Default::default()
        };
        EditedPerson { person, given_unset, family_unset }
    }
}

/// The bridge's answer to a write to the local address book.
fn local_write_json(write: store::local_people::Write) -> Value {
    match write {
        store::local_people::Write::Saved { id, version } => json!({ "ok": true, "id": id, "version": version }),
        store::local_people::Write::Conflict { current } => json!({
            "ok": false,
            "conflict": true,
            "current": current.map(|stored| json!({
                "id": stored.id,
                "name": stored.person.name,
                "given": stored.person.given,
                "family": stored.person.family,
                "organisation": stored.person.organisation,
                "note": stored.person.note,
                "emails": stored.person.emails,
                "phones": stored.person.phones,
                "version": stored.version,
            })),
        }),
    }
}

/// The id a Google account's contacts are kept under: one book per account,
/// so reading them again replaces rather than doubles everybody.
pub fn google_source_id(account: &str) -> String {
    format!("google-{account}")
}

/// Makes sure a Google account has its book, without reading it. `name` is
/// only used for a book made now.
pub fn ensure_google_source(engine: &Arc<Engine>, account: &str, name: &str) -> Result<String> {
    let id = google_source_id(account);
    let existing = store::contact_source(&engine.db.lock().unwrap(), &id)?;
    if existing.is_none() {
        store::upsert_contact_source(
            &engine.db.lock().unwrap(),
            &store::ContactSource {
                writable: None,
                id: id.clone(),
                kind: "google".into(),
                account: account.to_string(),
                url: String::new(),
                username: String::new(),
                name: name.to_string(),
                enabled: true,
                ctag: String::new(),
                last_sync_at: 0,
                last_error: String::new(),
            },
            chrono::Utc::now().timestamp(),
        )?;
    }
    Ok(id)
}

/// `google.contacts.sync`: a Google account's contacts, read with the token
/// the account already holds.
pub async fn google_sync(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let id = ensure_google_source(engine, &account, &req_str(p, "name").unwrap_or_default())?;
    let outcome = sync_source(engine, &id).await;
    Ok(json!({ "id": id, "ok": outcome.is_ok(), "error": outcome.err().map(|e| format!("{e:#}")) }))
}

/// `carddav.sync`: one book read again, whatever kind it is.
pub async fn source_sync(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let id = req_str(p, "id")?;
    let outcome = sync_source(engine, &id).await;
    Ok(json!({ "ok": outcome.is_ok(), "error": outcome.err().map(|e| format!("{e:#}")) }))
}

/// `carddav.list`: the books brought in, with when each was last read and
/// what went wrong the last time, if anything.
pub fn sources(engine: &Arc<Engine>) -> Result<Value> {
    let sources = store::contact_sources(&engine.db.lock().unwrap())?;
    Ok(json!({ "sources": sources }))
}

/// Read one book (CardDAV or Google) into the address book, and record how
/// it went.
///
/// Off the async runtime, because the DAV client is blocking HTTP. The
/// outcome is written to the source either way: a sync that failed leaves its
/// reason where the settings screen can show it, and a sync that succeeded
/// clears whatever the last one said.
pub async fn sync_source(engine: &Arc<Engine>, id: &str) -> Result<()> {
    let source = store::contact_source(&engine.db.lock().unwrap(), id)?
        .with_context(|| format!("no such contact source: {id}"))?;

    let fetched = match source.kind.as_str() {
        "carddav" => {
            let password = crate::secrets::load(id)
                .map(|secrets| secrets.password)
                .unwrap_or_default();
            let proxy = store::account_proxy(&engine.db.lock().unwrap(), &source.account)?;
            let transport = crate::carddav::http::UreqTransport {
                username: source.username.clone(),
                password,
                proxy,
            };
            let url = source.url.clone();
            tokio::task::spawn_blocking(move || {
                let contents = crate::carddav::client::fetch_book_contents(&transport, &url)?;
                // Asked each sync: a share can be made read-only at any time.
                let writable = crate::carddav::client::book_writable(&transport, &url).unwrap_or(None);
                let styles: Vec<_> = contents.groups.iter().map(|entry| entry.group.style).collect();
                let style = crate::contacts::groups::style_for_book(&styles, &contents.versions);
                let groups = contents
                    .groups
                    .into_iter()
                    .map(|entry| store::contact_groups::GroupRow {
                        uid: entry.group.uid,
                        name: entry.group.name,
                        members: entry.group.members,
                        href: entry.href,
                        version: entry.etag,
                        style: entry.group.style.as_str().to_string(),
                    })
                    .collect::<Vec<_>>();
                let rows = contents
                    .cards
                    .into_iter()
                    .map(|card| store::SyncedRow {
                        person: card.person,
                        photo_key: String::new(),
                        href: card.href,
                        version: card.etag,
                    })
                    .collect::<Vec<_>>();
                anyhow::Ok((rows, Some(writable), Some(groups), style.as_str()))
            })
            .await?
        }
        // The mail account's own token, refreshed if it had expired. The one
        // new thing asked of it is the contacts scope; a token from before
        // that existed is refused by Google and the refusal names the fix.
        "google" => match engine.ensure_valid_creds(&source.account).await {
            Ok(creds) if creds.auth_type == "gmail_oauth" => {
                let token = creds.access_token.clone().unwrap_or_default();
                let proxy = creds.proxy.clone();
                if token.is_empty() {
                    Err(anyhow::anyhow!("account needs reconnect: {}", source.account))
                } else {
                    tokio::task::spawn_blocking(move || {
                        crate::contacts::google::fetch_connections_and_groups(&token, &proxy).map(|(people, groups)| {
                            let rows = people
                                .into_iter()
                                .map(|person| store::SyncedRow { person, ..Default::default() })
                                .collect::<Vec<_>>();
                            // Labels, read-only (ADR-0052).
                            let groups = groups.map(|groups| {
                                groups
                                    .into_iter()
                                    .map(|group| store::contact_groups::GroupRow {
                                        uid: group.resource_name,
                                        name: group.name,
                                        members: group.members,
                                        ..Default::default()
                                    })
                                    .collect::<Vec<_>>()
                            });
                            (rows, None, groups, "")
                        })
                    })
                    .await?
                }
            }
            Ok(_) => Err(anyhow::anyhow!("not a Google account: {}", source.account)),
            Err(error) => Err(error),
        },
        other => Err(anyhow::anyhow!("unknown contact source kind: {other}")),
    };

    let now = chrono::Utc::now().timestamp();
    let db = engine.db.lock().unwrap();
    match fetched {
        Ok((rows, writable, groups, style)) => {
            let origin = store::BookOrigin {
                source: source.kind.clone(),
                account: source.account.clone(),
                book: source.id.clone(),
            };
            // Photos are not cached yet; the key stays empty until they are.
            store::replace_book_rows(&db, &origin, &rows, now)?;
            // Groups that could not be read are kept as they were.
            if let Some(groups) = groups {
                store::contact_groups::replace_book_groups(&db, &origin, &groups, now)?;
            }
            if !style.is_empty() {
                store::contact_groups::set_book_style(&db, id, style)?;
            }
            if let Some(writable) = writable {
                store::set_contact_source_writable(&db, id, writable)?;
            }
            store::mark_contact_source_synced(&db, id, "", "", now)?;
            Ok(())
        }
        Err(error) => {
            store::mark_contact_source_synced(&db, id, "", &format!("{error:#}"), now)?;
            Err(error)
        }
    }
}

// ---- Groups (ADR-0052) ------------------------------------------------------

/// `people.groups`: every group, with its members as the composer and the
/// Personas view need them — name parts and first address.
pub fn groups(engine: &Arc<Engine>) -> Result<Value> {
    let db = engine.db.lock().unwrap();
    let groups = store::contact_groups::list(&db)?;
    let writable = store::contact_sources_writable(&db)?;
    let details = store::contact_groups::member_details(&db)?;
    Ok(json!({
        "groups": groups.iter().map(|group| {
            let members: Vec<Value> = details
                .iter()
                .filter(|member| member.group_id == group.id)
                .map(|member| json!({
                    "id": member.person_id,
                    "name": member.name,
                    "given": member.given,
                    "family": member.family,
                    "addr": member.addr,
                }))
                .collect();
            json!({
                "id": group.id,
                "source": group.origin.source,
                "account": group.origin.account,
                "book": group.origin.book,
                "name": group.name,
                "version": group.version,
                "members": members,
                // The local book's, and a CardDAV book's unless the server
                // said it is read-only. Google's labels are read here only.
                "editable": group.origin.source == "local"
                    || (group.origin.source == "carddav"
                        && writable.get(&group.origin.book).copied().flatten() != Some(false)),
            })
        }).collect::<Vec<_>>()
    }))
}

/// The UID a person id names in one book, if it is in that book.
fn uid_in_book(origin: &store::BookOrigin, person_id: &str) -> Option<String> {
    person_id.strip_prefix(&origin.person_id("")).filter(|uid| !uid.is_empty()).map(str::to_string)
}

fn group_conflict_json(id: &str, current: Option<(String, Vec<String>, String)>) -> Value {
    json!({
        "ok": false,
        "conflict": true,
        "current": current.map(|(name, members, version)| json!({
            "id": id, "name": name, "members": members, "version": version,
        })),
    })
}

/// `people.groupSave`: creates a group (in the local book, or with `book` in a
/// CardDAV one), or renames one and sets its members from the version it was
/// read at. A different version saves nothing and answers with the copy that
/// is there now (ADR-0012).
pub async fn group_save(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let id = p.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string);
    let version = p.get("version").and_then(Value::as_str).map(str::to_string);
    if id.is_some() && version.is_none() {
        anyhow::bail!("an edit must say which version it was made from");
    }
    let name = req_str(p, "name")?.trim().to_string();
    if name.is_empty() {
        anyhow::bail!("a group needs a name");
    }
    let members: Vec<String> =
        serde_json::from_value(p.get("members").cloned().unwrap_or_else(|| json!([]))).context("members")?;
    let book = p.get("book").and_then(Value::as_str).filter(|book| !book.is_empty() && *book != "local");
    let stored = match &id {
        Some(id) => Some(
            store::contact_groups::get(&engine.db.lock().unwrap(), id)?
                .map_or_else(|| Err(anyhow::anyhow!("that group is no longer there")), Ok)?,
        ),
        None => None,
    };
    let target_source = match (&stored, book) {
        (Some(stored), _) => stored.origin.source.clone(),
        (None, Some(book)) => {
            store::contact_source(&engine.db.lock().unwrap(), book)?.context("that address book is no longer set up")?.kind
        }
        (None, None) => "local".to_string(),
    };
    match target_source.as_str() {
        "local" => {
            let write = store::contact_groups::save_local(
                &engine.db.lock().unwrap(),
                id.as_deref(),
                version.as_deref(),
                &name,
                &members,
                now_unix(),
            )?;
            Ok(match write {
                store::contact_groups::Write::Saved { id, version } => json!({ "ok": true, "id": id, "version": version }),
                store::contact_groups::Write::Conflict { current } => group_conflict_json(
                    id.as_deref().unwrap_or_default(),
                    current.map(|group| (group.name, group.members, group.version)),
                ),
            })
        }
        "carddav" => {
            let book_id = stored.as_ref().map(|group| group.origin.book.clone()).or(book.map(str::to_string)).unwrap_or_default();
            let (source, transport) = carddav_target(engine, &book_id)?;
            let origin =
                store::BookOrigin { source: source.kind.clone(), account: source.account.clone(), book: source.id.clone() };
            // A CardDAV group names its members by UID in its own book.
            let mut wanted = Vec::new();
            for member in &members {
                let uid = uid_in_book(&origin, member)
                    .context("a group on a server can only hold people from the same address book")?;
                if !wanted.contains(&uid) {
                    wanted.push(uid);
                }
            }
            let book_url = source.url.clone();
            let now = now_unix();
            let outcome = match &stored {
                Some(stored) => {
                    if stored.href.is_empty() {
                        anyhow::bail!("this group's place on the server is not known yet; sync the address book and try again");
                    }
                    // Only the members the editor could see: one whose card is
                    // not here (another book, not synced) stays in the group.
                    let visible: Vec<String> = store::contact_groups::member_details(&engine.db.lock().unwrap())?
                        .into_iter()
                        .filter(|member| member.group_id == stored.id)
                        .map(|member| member.person_id)
                        .collect();
                    let before: Vec<String> = stored
                        .members
                        .iter()
                        .filter(|member| visible.contains(member))
                        .filter_map(|member| uid_in_book(&origin, member))
                        .collect();
                    let add: Vec<String> = wanted.iter().filter(|uid| !before.contains(uid)).cloned().collect();
                    let remove: Vec<String> = before.iter().filter(|uid| !wanted.contains(uid)).cloned().collect();
                    let (href, read_at, name) = (stored.href.clone(), version.clone().unwrap_or_default(), name.clone());
                    tokio::task::spawn_blocking(move || {
                        crate::carddav::write::save_group_existing(&transport, &book_url, &href, &read_at, &name, &add, &remove, now)
                    })
                    .await??
                }
                None => {
                    let style = crate::contacts::groups::GroupStyle::parse(&store::contact_groups::book_style(
                        &engine.db.lock().unwrap(),
                        &source.id,
                    )?)
                    // Not known yet: 3.0 is what every server takes.
                    .unwrap_or(crate::contacts::groups::GroupStyle::Apple);
                    let name = name.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::carddav::write::save_group_new(&transport, &book_url, &name, &wanted, style)
                    })
                    .await??
                }
            };
            record_group_outcome(engine, &origin, outcome, id.as_deref())
        }
        _ => anyhow::bail!("this address book's groups are read-only here"),
    }
}

/// `people.groupDelete`: deletes a group from the version it was read at.
/// The people in it stay.
pub async fn group_delete(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let id = req_str(p, "id")?;
    let version = req_str(p, "version")?;
    let Some(stored) = store::contact_groups::get(&engine.db.lock().unwrap(), &id)? else {
        return Ok(json!({ "ok": true }));
    };
    match stored.origin.source.as_str() {
        "local" => match store::contact_groups::delete_local(&engine.db.lock().unwrap(), &id, &version)? {
            store::contact_groups::Write::Saved { .. } => Ok(json!({ "ok": true })),
            store::contact_groups::Write::Conflict { current } => Ok(group_conflict_json(
                &id,
                current.map(|group| (group.name, group.members, group.version)),
            )),
        },
        "carddav" => {
            if stored.href.is_empty() {
                anyhow::bail!("this group's place on the server is not known yet; sync the address book and try again");
            }
            let (source, transport) = carddav_target(engine, &stored.origin.book)?;
            let (book_url, href) = (source.url.clone(), stored.href.clone());
            let outcome = tokio::task::spawn_blocking(move || {
                crate::carddav::write::delete_group(&transport, &book_url, &href, &version)
            })
            .await??;
            record_group_outcome(engine, &stored.origin, outcome, Some(&id))
        }
        _ => anyhow::bail!("this address book's groups are read-only here"),
    }
}

fn record_group_outcome(
    engine: &Engine,
    origin: &store::BookOrigin,
    outcome: crate::carddav::write::GroupOutcome,
    id: Option<&str>,
) -> Result<Value> {
    use crate::carddav::write::GroupOutcome;
    let db = engine.db.lock().unwrap();
    match outcome {
        GroupOutcome::Saved { href, version, group } => {
            let id = store::contact_groups::put_synced_group(
                &db,
                origin,
                &store::contact_groups::GroupRow {
                    uid: group.uid,
                    name: group.name,
                    members: group.members,
                    href,
                    version: version.clone(),
                    style: group.style.as_str().to_string(),
                },
                now_unix(),
            )?;
            Ok(json!({ "ok": true, "id": id, "version": version }))
        }
        GroupOutcome::Deleted => {
            if let Some(id) = id {
                store::contact_groups::forget_group(&db, id)?;
            }
            Ok(json!({ "ok": true }))
        }
        GroupOutcome::Conflict { current } => Ok(group_conflict_json(
            id.unwrap_or_default(),
            current.map(|(group, version)| {
                let members = group.members.iter().map(|uid| origin.person_id(uid)).collect();
                (group.name, members, version)
            }),
        )),
    }
}

/// `people.names`: the address book's name for each address asked about,
/// with its parts, so a list can show a sender whose message carried no name
/// the way the reader orders names (ADR-0052). Addresses nobody in the book
/// has are left out.
pub fn names(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let addrs: Vec<String> = p
        .get("addrs")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(|addr| addr.trim().to_lowercase()).collect())
        .unwrap_or_default();
    let found = store::contact_groups::book_names(&engine.db.lock().unwrap(), &addrs)?;
    let mut out = serde_json::Map::new();
    for (addr, name, given, family) in found {
        out.entry(addr).or_insert_with(|| json!({ "name": name, "given": given, "family": family }));
    }
    Ok(json!({ "names": out }))
}
