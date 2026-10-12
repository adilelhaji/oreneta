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
    let person = input.into_person();
    let stored = match id {
        Some(id) => store::synced_person(&engine.db.lock().unwrap(), id)?,
        None => None,
    };
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
    let transport = crate::carddav::http::UreqTransport { username: source.username.clone(), password };
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

impl PersonInput {
    fn into_person(self) -> crate::contacts::person::Person {
        use crate::contacts::person::{EmailAddress, Person, PhoneNumber};
        Person {
            name: self.name,
            organisation: self.organisation,
            note: self.note,
            emails: self.emails.into_iter().map(|e| EmailAddress { addr: e.addr, label: e.label }).collect(),
            phones: self.phones.into_iter().map(|p| PhoneNumber { number: p.addr, label: p.label }).collect(),
            ..Default::default()
        }
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
                "organisation": stored.person.organisation,
                "note": stored.person.note,
                "emails": stored.person.emails,
                "phones": stored.person.phones,
                "version": stored.version,
            })),
        }),
    }
}
