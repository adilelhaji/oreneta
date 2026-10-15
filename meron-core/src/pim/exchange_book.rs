//! An Exchange account's address book (ADR-0058): the people of its Contacts
//! folder, read only as ADR-0012 keeps them, and its distribution lists as
//! contact groups (ADR-0052), read and written.
//!
//! A list's members are kept by person id like any group's: a contact of the
//! folder by its item id, and somebody who is no contact here (an address
//! typed in, a directory entry) by `mailto:` and the address, with the name
//! and address the server gave, so the list shows and expands to them too.
//!
//! A write names the change key the list was read at. The list is read from
//! the server first; a different change key saves nothing and answers with
//! the copy there now, and the write itself asks the server never to
//! overwrite, so a change made in between is refused there too (ADR-0012).
//! Only what changed is sent: the name, the members added and the members
//! taken out, by the key the server gave each. A member the editor could not
//! see stays as it is.

use std::sync::{Arc, Mutex};

use anyhow::{bail, Context as _, Result};
use rusqlite::Connection;
use serde_json::{json, Value};

use super::req_str;
use crate::engine::Engine;
use crate::exchange::book::{Book, DistributionList, ListWrite, NewMember};
use crate::exchange::EwsClient;
use crate::store::{self, contact_groups, BookOrigin};

/// The book an Exchange account's contacts are kept under: one per account.
pub fn source_id(account: &str) -> String {
    format!("exchange-{account}")
}

pub fn origin(account: &str) -> BookOrigin {
    BookOrigin { source: "exchange".to_string(), account: account.to_string(), book: source_id(account) }
}

/// Makes sure an Exchange account has its book, without reading it.
pub fn ensure_source(conn: &Connection, account: &str, name: &str, now: i64) -> Result<String> {
    let id = source_id(account);
    if store::contact_source(conn, &id)?.is_none() {
        store::upsert_contact_source(
            conn,
            &store::ContactSource {
                writable: None,
                id: id.clone(),
                kind: "exchange".into(),
                account: account.to_string(),
                url: String::new(),
                username: String::new(),
                name: name.to_string(),
                enabled: true,
                ctag: String::new(),
                last_sync_at: 0,
                last_error: String::new(),
            },
            now,
        )?;
    }
    Ok(id)
}

/// A client signed in as the account, which must be an Exchange one.
pub async fn client(engine: &Arc<Engine>, account: &str) -> Result<EwsClient> {
    let creds = engine.ensure_valid_creds(account).await?;
    if !creds.is_ews() {
        bail!("not an Exchange account: {account}");
    }
    Ok(EwsClient::for_account(&creds))
}

/// The labels of a list's members who are no contact of the book, as
/// `(person id, name, address)`.
fn labels(origin: &BookOrigin, list: &DistributionList) -> Vec<(String, String, String)> {
    list.members
        .iter()
        .filter(|member| member.item_id.is_none() && !member.addr.is_empty())
        .filter_map(|member| member.uid().map(|uid| (origin.person_id(&uid), member.name.clone(), member.addr.clone())))
        .collect()
}

fn group_row(list: &DistributionList) -> contact_groups::GroupRow {
    let mut members: Vec<String> = Vec::new();
    for uid in list.members.iter().filter_map(|member| member.uid()) {
        if !members.contains(&uid) {
            members.push(uid);
        }
    }
    contact_groups::GroupRow {
        uid: list.id.clone(),
        name: list.name.clone(),
        members,
        href: list.id.clone(),
        version: list.change_key.clone(),
        style: String::new(),
    }
}

/// Replaces the book's people and lists with what the server holds.
pub fn store_book(conn: &Connection, origin: &BookOrigin, book: &Book, now: i64) -> Result<()> {
    let rows: Vec<store::SyncedRow> = book
        .contacts
        .iter()
        .filter(|contact| contact.person.is_useful())
        .map(|contact| store::SyncedRow {
            person: contact.person.clone(),
            photo_key: String::new(),
            href: contact.person.uid.clone(),
            version: contact.change_key.clone(),
        })
        .collect();
    store::replace_book_rows(conn, origin, &rows, now)?;
    let groups: Vec<contact_groups::GroupRow> = book.lists.iter().map(group_row).collect();
    contact_groups::replace_book_groups(conn, origin, &groups, now)?;
    for list in &book.lists {
        contact_groups::label_members(conn, &contact_groups::group_id(origin, &list.id), &labels(origin, list))?;
    }
    Ok(())
}

/// Records one list as the server now holds it, after a write there.
fn record(conn: &Connection, origin: &BookOrigin, list: &DistributionList, now: i64) -> Result<String> {
    let id = contact_groups::put_synced_group(conn, origin, &group_row(list), now)?;
    contact_groups::label_members(conn, &id, &labels(origin, list))?;
    Ok(id)
}

/// What a write to a list came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupWrite {
    Saved { id: String, version: String },
    Deleted,
    /// Changed or deleted on the server since it was read: nothing written.
    /// The copy there now, as name, person ids and version.
    Conflict { current: Option<(String, Vec<String>, String)> },
}

impl GroupWrite {
    pub fn to_json(&self, id: &str) -> Value {
        match self {
            GroupWrite::Saved { id, version } => json!({ "ok": true, "id": id, "version": version }),
            GroupWrite::Deleted => json!({ "ok": true }),
            GroupWrite::Conflict { current } => json!({
                "ok": false,
                "conflict": true,
                "current": current.as_ref().map(|(name, members, version)| json!({
                    "id": id, "name": name, "members": members, "version": version,
                })),
            }),
        }
    }
}

fn conflict(origin: &BookOrigin, current: Option<DistributionList>) -> GroupWrite {
    GroupWrite::Conflict {
        current: current.map(|list| {
            let members = group_row(&list).members.iter().map(|uid| origin.person_id(uid)).collect();
            (list.name, members, list.change_key)
        }),
    }
}

fn lock(db: &Mutex<Connection>) -> std::sync::MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A person id of this book as the member to write: a contact of the folder
/// (by item id, at its first address), or an address that is no contact.
fn new_member(conn: &Connection, origin: &BookOrigin, person: &str) -> Result<NewMember> {
    let uid = person
        .strip_prefix(&origin.person_id(""))
        .filter(|uid| !uid.is_empty())
        .context("a group on a server can only hold people from the same address book")?;
    if let Some(addr) = uid.strip_prefix("mailto:") {
        let name = contact_groups::member_details(conn)?
            .into_iter()
            .find(|member| member.person_id == person)
            .map(|member| member.name)
            .unwrap_or_default();
        return Ok(NewMember { item_id: None, name, addr: addr.to_string() });
    }
    let stored = store::synced_person(conn, person)?.context("that person is no longer in the address book")?;
    let addr = stored
        .person
        .emails
        .first()
        .map(|email| email.addr.clone())
        .with_context(|| format!("{} has no email address to put in a list", stored.person.name))?;
    Ok(NewMember { item_id: Some(uid.to_string()), name: stored.person.name, addr })
}

/// Creates a list (`stored` absent) or renames one and sets its members,
/// from the version it was read at. `wanted` holds person ids of this book.
pub fn save_group(
    client: &EwsClient,
    db: &Mutex<Connection>,
    origin: &BookOrigin,
    stored: Option<&contact_groups::StoredGroup>,
    read_at: &str,
    name: &str,
    wanted: &[String],
    now: i64,
) -> Result<GroupWrite> {
    let name = name.trim();
    if name.is_empty() {
        bail!("a group needs a name");
    }
    let mut members: Vec<String> = Vec::new();
    for person in wanted {
        if !members.contains(person) {
            members.push(person.clone());
        }
    }
    let Some(stored) = stored else {
        let new: Vec<NewMember> = {
            let conn = lock(db);
            members.iter().map(|person| new_member(&conn, origin, person)).collect::<Result<_>>()?
        };
        let (id, _) = client.create_list(name, &new)?;
        let list = client.read_list(&id)?.context("Exchange did not keep the list it created")?;
        let group = record(&lock(db), origin, &list, now)?;
        return Ok(GroupWrite::Saved { id: group, version: list.change_key });
    };
    let Some(server) = client.read_list(&stored.uid)? else {
        return Ok(GroupWrite::Conflict { current: None });
    };
    if server.change_key != read_at {
        return Ok(conflict(origin, Some(server)));
    }
    // Only the members the editor could see: one it could not stays.
    let (add, remove_keys) = {
        let conn = lock(db);
        let before: Vec<String> = contact_groups::member_details(&conn)?
            .into_iter()
            .filter(|member| member.group_id == stored.id)
            .map(|member| member.person_id)
            .collect();
        let add = members
            .iter()
            .filter(|person| !before.contains(person))
            .map(|person| new_member(&conn, origin, person))
            .collect::<Result<Vec<_>>>()?;
        let gone: Vec<String> = before
            .iter()
            .filter(|person| !members.contains(person))
            .filter_map(|person| person.strip_prefix(&origin.person_id("")).map(str::to_string))
            .collect();
        let keys = server
            .members
            .iter()
            .filter(|member| member.uid().is_some_and(|uid| gone.contains(&uid)))
            .map(|member| member.key.clone())
            .filter(|key| !key.is_empty())
            .collect::<Vec<_>>();
        (add, keys)
    };
    let rename = (server.name != name).then_some(name);
    match client.update_list(&stored.uid, read_at, rename, &add, &remove_keys)? {
        ListWrite::Conflict => Ok(conflict(origin, client.read_list(&stored.uid)?)),
        ListWrite::Saved { .. } => {
            let list = client.read_list(&stored.uid)?.context("the list is gone from the server")?;
            let id = record(&lock(db), origin, &list, now)?;
            Ok(GroupWrite::Saved { id, version: list.change_key })
        }
    }
}

/// Deletes a list from the version it was read at. Its members stay.
pub fn delete_group(
    client: &EwsClient,
    db: &Mutex<Connection>,
    origin: &BookOrigin,
    stored: &contact_groups::StoredGroup,
    read_at: &str,
) -> Result<GroupWrite> {
    match client.delete_list(&stored.uid, read_at)? {
        ListWrite::Saved { .. } => {
            contact_groups::forget_group(&lock(db), &stored.id)?;
            Ok(GroupWrite::Deleted)
        }
        ListWrite::Conflict => Ok(conflict(origin, client.read_list(&stored.uid)?)),
    }
}

/// `exchange.contacts.sync`: an Exchange account's contacts and lists, read
/// with the account's own sign-in. One book per account.
pub async fn sync(engine: &Arc<Engine>, p: &Value) -> Result<Value> {
    let account = req_str(p, "account")?;
    let id = ensure_source(
        &engine.db.lock().unwrap(),
        &account,
        &req_str(p, "name").unwrap_or_default(),
        chrono::Utc::now().timestamp(),
    )?;
    let outcome = super::people::sync_source(engine, &id).await;
    Ok(json!({ "id": id, "ok": outcome.is_ok(), "error": outcome.err().map(|e| format!("{e:#}")) }))
}

/// Reads the book of `account` from the server (for `sync_source`).
pub async fn fetch(engine: &Arc<Engine>, account: &str) -> Result<Book> {
    let client = client(engine, account).await?;
    tokio::task::spawn_blocking(move || client.read_book()).await?
}

#[cfg(test)]
mod tests;
