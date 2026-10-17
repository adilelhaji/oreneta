//! An Exchange account's address books (ADR-0058, ADR-0066): one for its
//! Contacts folder and one for each contact folder under it, each with its
//! people and its distribution lists as contact groups (ADR-0052), all read
//! and written.
//!
//! The account's own book (`exchange-<account>`, the Contacts folder) is the
//! one the reader brings in. Reading it lists the contact folders under
//! Contacts and keeps one book per folder (`exchange-<account>/<folder id>`,
//! the folder id in `url`), named by its path: a folder renamed or moved
//! keeps its book, a folder gone takes its book and its people with it, and
//! a listing that fails removes nothing. The folder books come and go with
//! the account's own: they are not removed one by one.
//!
//! A list's members are kept by person id like any group's: a contact by its
//! item id, and somebody who is no contact here (an address typed in, a
//! directory entry) by `mailto:` and the address. Every member with an
//! address carries the name and address the server gave, so one who is a
//! contact of another folder still shows and expands.
//!
//! A write names the change key the item was read at. The item is read from
//! the server first; a different change key saves nothing and answers with
//! the copy there now, and the write itself asks the server never to
//! overwrite, so a change made in between is refused there too (ADR-0012).
//! Only what changed is sent. A contact created here carries an id of ours,
//! so a creation whose answer was lost is found again, not made twice.

use std::sync::{Arc, Mutex};

use anyhow::{bail, Context as _, Result};
use rusqlite::Connection;
use serde_json::{json, Value};

use super::req_str;
use crate::contacts::person::Person;
use crate::engine::Engine;
use crate::exchange::book::{Book, Contact, ContactFolder, Created, DistributionList, ListWrite, NewMember};
use crate::exchange::EwsClient;
use crate::store::{self, contact_groups, BookOrigin};

/// The book an Exchange account's Contacts folder is kept under.
pub fn source_id(account: &str) -> String {
    format!("exchange-{account}")
}

/// The book a contact folder under Contacts is kept under, by its id.
pub fn folder_source_id(account: &str, folder: &str) -> String {
    format!("exchange-{account}/{folder}")
}

/// The origin of an account's Contacts folder book.
pub fn origin(account: &str) -> BookOrigin {
    BookOrigin { source: "exchange".to_string(), account: account.to_string(), book: source_id(account) }
}

/// Where a book of an Exchange account lives: its origin here and its
/// folder there (empty for the Contacts folder).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub origin: BookOrigin,
    pub folder: String,
}

impl Target {
    /// The account's Contacts folder.
    pub fn root(account: &str) -> Target {
        Target { origin: origin(account), folder: String::new() }
    }

    pub fn of(source: &store::ContactSource) -> Result<Target> {
        if source.kind != "exchange" {
            bail!("not an Exchange address book: {}", source.id);
        }
        Ok(Target {
            origin: BookOrigin { source: source.kind.clone(), account: source.account.clone(), book: source.id.clone() },
            folder: source.url.clone(),
        })
    }
}

/// The Exchange book `book` names.
pub fn target(conn: &Connection, book: &str) -> Result<Target> {
    Target::of(&store::contact_source(conn, book)?.context("that address book is no longer set up")?)
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

/// The folder books of an account, as they are kept here.
fn folder_sources(conn: &Connection, account: &str) -> Result<Vec<store::ContactSource>> {
    Ok(store::contact_sources(conn)?
        .into_iter()
        .filter(|source| source.kind == "exchange" && source.account == account && !source.url.is_empty())
        .collect())
}

/// Whether a book is one of an account's contact folders under Contacts,
/// read with the account's own book rather than on its own.
pub fn is_folder_book(source: &store::ContactSource) -> bool {
    source.kind == "exchange" && !source.url.is_empty()
}

/// Removes an Exchange book. The account's own takes its folder books with
/// it; a folder book alone is refused, because the next read of the
/// account's book would only bring it back. Answers the ids removed.
pub fn remove_source(conn: &Connection, source: &store::ContactSource) -> Result<Vec<String>> {
    if is_folder_book(source) {
        bail!("this contact folder comes with the account's Exchange contacts; remove those to stop reading it");
    }
    let mut removed: Vec<String> = folder_sources(conn, &source.account)?.into_iter().map(|source| source.id).collect();
    removed.push(source.id.clone());
    for id in &removed {
        store::delete_contact_source(conn, id)?;
    }
    Ok(removed)
}

/// A client signed in as the account, which must be an Exchange one.
pub async fn client(engine: &Arc<Engine>, account: &str) -> Result<EwsClient> {
    let creds = engine.ensure_valid_creds(account).await?;
    if !creds.is_ews() {
        bail!("not an Exchange account: {account}");
    }
    Ok(EwsClient::for_account(&creds))
}

/// The labels of a list's members with an address, as `(person id, name,
/// address)`: shown as these when no contact of the book stands for them —
/// somebody typed in, a directory entry, a contact of another folder.
fn labels(origin: &BookOrigin, list: &DistributionList) -> Vec<(String, String, String)> {
    list.members
        .iter()
        .filter(|member| !member.addr.is_empty())
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

fn synced_row(contact: &Contact) -> store::SyncedRow {
    store::SyncedRow {
        person: contact.person.clone(),
        photo_key: String::new(),
        href: contact.person.uid.clone(),
        version: contact.change_key.clone(),
    }
}

/// Replaces the book's people and lists with what the server holds.
pub fn store_book(conn: &Connection, origin: &BookOrigin, book: &Book, now: i64) -> Result<()> {
    let rows: Vec<store::SyncedRow> =
        book.contacts.iter().filter(|contact| contact.person.is_useful()).map(synced_row).collect();
    store::replace_book_rows(conn, origin, &rows, now)?;
    let groups: Vec<contact_groups::GroupRow> = book.lists.iter().map(group_row).collect();
    let labelled: Vec<(String, Vec<(String, String, String)>)> =
        book.lists.iter().map(|list| (list.id.clone(), labels(origin, list))).collect();
    contact_groups::replace_book_groups_labelled(conn, origin, &groups, &labelled, now)?;
    Ok(())
}

// ---- Reading -----------------------------------------------------------------

/// What reading a book brought: its folder's people and lists and, for an
/// account's own book, the contact folders under it with each one's.
#[derive(Debug)]
pub struct Read {
    pub book: Result<Book>,
    /// `None` when the folders were not asked for (a folder book read on its
    /// own) or the book itself could not be read.
    pub folders: Option<Result<Vec<(ContactFolder, Result<Book>)>>>,
}

/// Reads the folder `folder` (empty for Contacts) and, with `with_folders`,
/// the contact folders under Contacts.
pub fn read(client: &EwsClient, folder: &str, with_folders: bool) -> Read {
    let book = client.read_book(folder);
    let folders = (with_folders && book.is_ok()).then(|| {
        client.contact_folders().map(|folders| {
            folders
                .into_iter()
                .map(|folder| {
                    let book = client.read_book(&folder.id);
                    (folder, book)
                })
                .collect()
        })
    });
    Read { book, folders }
}

fn mark(conn: &Connection, id: &str, error: Option<&anyhow::Error>, now: i64) -> Result<()> {
    store::mark_contact_source_synced(conn, id, "", &error.map(|error| format!("{error:#}")).unwrap_or_default(), now)
}

/// Keeps what [`read`] brought for `source`, and records how it went on each
/// book. A folder that could not be read keeps what it had and says why; the
/// account's book then says so too, and this fails, so an incomplete read is
/// never taken for a complete one.
pub fn record(conn: &Connection, source: &store::ContactSource, read: Read, now: i64) -> Result<()> {
    let target = Target::of(source)?;
    let book = match read.book {
        Ok(book) => book,
        Err(error) => {
            mark(conn, &source.id, Some(&error), now)?;
            return Err(error);
        }
    };
    store_book(conn, &target.origin, &book, now)?;
    let mut problem: Option<anyhow::Error> = None;
    match read.folders {
        None => {}
        // Nothing is removed on a listing that failed: a folder not listed
        // is not a folder gone.
        Some(Err(error)) => problem = Some(error.context("the contact folders under Contacts could not be listed")),
        Some(Ok(folders)) => {
            let kept = folder_sources(conn, &source.account)?;
            let mut listed: Vec<String> = Vec::new();
            for (folder, book) in folders {
                let id = folder_source_id(&source.account, &folder.id);
                listed.push(id.clone());
                let name = if source.name.trim().is_empty() { folder.path.clone() } else { format!("{} / {}", source.name, folder.path) };
                let known = kept.iter().find(|kept| kept.id == id);
                let child = store::ContactSource {
                    id: id.clone(),
                    kind: "exchange".into(),
                    account: source.account.clone(),
                    url: folder.id.clone(),
                    username: String::new(),
                    name,
                    enabled: known.map_or(true, |known| known.enabled),
                    ctag: String::new(),
                    last_sync_at: 0,
                    last_error: String::new(),
                    writable: None,
                };
                store::upsert_contact_source(conn, &child, now)?;
                match book {
                    Ok(book) => {
                        store_book(conn, &Target::of(&child)?.origin, &book, now)?;
                        mark(conn, &id, None, now)?;
                    }
                    Err(error) => {
                        mark(conn, &id, Some(&error), now)?;
                        problem.get_or_insert(error.context(format!("the contact folder “{}” could not be read", folder.path)));
                    }
                }
            }
            // A folder the complete listing no longer has is gone (deleted,
            // or moved out of Contacts): its book and its people go too.
            for gone in kept.iter().filter(|kept| !listed.contains(&kept.id)) {
                store::delete_contact_source(conn, &gone.id)?;
            }
        }
    }
    mark(conn, &source.id, problem.as_ref(), now)?;
    problem.map_or(Ok(()), Err)
}

/// Reads the book `source` from the server and keeps it (for
/// `people::sync_source`): an account's own book with its folders, a folder
/// book on its own.
pub async fn sync_source(engine: &Arc<Engine>, source: &store::ContactSource) -> Result<()> {
    let with_folders = !is_folder_book(source);
    let read = match client(engine, &source.account).await {
        Ok(client) => {
            let folder = source.url.clone();
            tokio::task::spawn_blocking(move || read(&client, &folder, with_folders)).await?
        }
        Err(error) => Read { book: Err(error), folders: None },
    };
    let now = chrono::Utc::now().timestamp();
    record(&engine.db.lock().unwrap(), source, read, now)
}

/// `exchange.contacts.sync`: an Exchange account's contacts and lists, of its
/// Contacts folder and the folders under it, read with the account's own
/// sign-in.
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

// ---- People ------------------------------------------------------------------

/// What a write to a person came to, in the editor's terms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersonWrite {
    Saved { id: String, version: String },
    Deleted,
    /// Changed or deleted on the server since it was read: nothing written.
    /// The copy there now, and its version.
    Conflict { current: Option<(Person, String)> },
}

impl PersonWrite {
    /// The answer in the shape every book's writes take (ADR-0012).
    pub fn to_json(&self, id: &str) -> Value {
        match self {
            PersonWrite::Saved { id, version } => json!({ "ok": true, "id": id, "version": version }),
            PersonWrite::Deleted => json!({ "ok": true }),
            PersonWrite::Conflict { current } => json!({
                "ok": false,
                "conflict": true,
                "current": current.as_ref().map(|(person, version)| json!({
                    "id": id,
                    "name": person.name,
                    "given": person.given,
                    "family": person.family,
                    "organisation": person.organisation,
                    "note": person.note,
                    "emails": person.emails,
                    "phones": person.phones,
                    "version": version,
                })),
            }),
        }
    }
}

fn lock(db: &Mutex<Connection>) -> std::sync::MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The person as the editor sent it, trimmed, without the empty rows an
/// editor leaves.
fn tidy(person: &Person) -> Person {
    let mut person = person.clone();
    person.name = person.name.trim().to_string();
    person.given = person.given.trim().to_string();
    person.family = person.family.trim().to_string();
    person.organisation = person.organisation.trim().to_string();
    person.emails.retain(|email| !email.addr.trim().is_empty());
    person.phones.retain(|phone| !phone.number.trim().is_empty());
    person
}

/// Keeps a contact here as the server now holds it.
fn record_contact(conn: &Connection, origin: &BookOrigin, contact: &Contact, now: i64) -> Result<String> {
    store::put_synced_person(conn, origin, &synced_row(contact), now)
}

/// A conflict, with the copy on the server now kept here as the version to
/// look at again and retry from; a contact gone from the server goes here too.
fn person_conflict(
    db: &Mutex<Connection>,
    origin: &BookOrigin,
    person_id: &str,
    current: Option<Contact>,
    now: i64,
) -> Result<PersonWrite> {
    let conn = lock(db);
    match &current {
        Some(contact) => {
            record_contact(&conn, origin, contact, now)?;
        }
        None => store::forget_person(&conn, person_id)?,
    }
    Ok(PersonWrite::Conflict { current: current.map(|contact| (contact.person, contact.change_key)) })
}

/// Creates a person in the folder of `target` carrying our id `marker`.
///
/// The editor sends one id for as long as it is open, so trying again after
/// a failure looks for the contact that id names first (`look_first`) and
/// adopts it rather than making a second one. When the answer to the
/// creation is lost, the contact is looked for the same way before anything
/// is said.
pub(crate) fn create_person(
    client: &EwsClient,
    db: &Mutex<Connection>,
    target: &Target,
    person: &Person,
    marker: &str,
    look_first: bool,
    now: i64,
) -> Result<PersonWrite> {
    let earlier = if look_first { client.find_marked_contact(&target.folder, marker)? } else { None };
    let id = match earlier {
        Some(found) => found.person.uid,
        None => match client.create_contact(&target.folder, person, marker)? {
            Created::Made { id, .. } => id,
            Created::Unknown(error) => match client.find_marked_contact(&target.folder, marker) {
                Ok(Some(found)) => found.person.uid,
                Ok(None) => return Err(error.context("Exchange did not answer, and the contact is not there")),
                Err(_) => {
                    return Err(error.context(
                        "Exchange did not answer, so the contact may have been created; saving again will not make a second one",
                    ))
                }
            },
        },
    };
    let contact = client
        .read_contact(&id)
        .and_then(|contact| contact.context("Exchange did not keep the contact it created"))
        .context(READ_BACK)?;
    let id = record_contact(&lock(db), &target.origin, &contact, now)?;
    Ok(PersonWrite::Saved { id, version: contact.change_key })
}

/// Why a write that reached the server still answers an error.
const READ_BACK: &str = "the change was saved on Exchange but could not be read back; read the address book again";

/// Creates a person in the folder of `target` (`stored` absent), or edits
/// one from the version it was read at. A creation names the id the editor
/// gave it (`marker`), or a new one when it gave none.
#[allow(clippy::too_many_arguments)]
pub fn save_person(
    client: &EwsClient,
    db: &Mutex<Connection>,
    target: &Target,
    stored: Option<&store::SyncedPerson>,
    read_at: &str,
    person: &Person,
    marker: Option<&str>,
    now: i64,
) -> Result<PersonWrite> {
    let person = tidy(person);
    let Some(stored) = stored else {
        return match marker {
            Some(marker) => create_person(client, db, target, &person, marker, true, now),
            None => create_person(client, db, target, &person, &uuid::Uuid::new_v4().to_string(), false, now),
        };
    };
    let person_id = target.origin.person_id(&stored.person.uid);
    let Some(server) = client.read_contact(&stored.person.uid)? else {
        return person_conflict(db, &target.origin, &person_id, None, now);
    };
    if read_at.is_empty() || server.change_key != read_at {
        return person_conflict(db, &target.origin, &person_id, Some(server), now);
    }
    match client.update_contact(&server, &person)? {
        ListWrite::Conflict => {
            let current = client.read_contact(&stored.person.uid)?;
            person_conflict(db, &target.origin, &person_id, current, now)
        }
        ListWrite::Saved { .. } => {
            let contact = client
                .read_contact(&stored.person.uid)
                .and_then(|contact| contact.context("the contact is gone from the server"))
                .context(READ_BACK)?;
            let id = record_contact(&lock(db), &target.origin, &contact, now)?;
            Ok(PersonWrite::Saved { id, version: contact.change_key })
        }
    }
}

/// Deletes a person from the version it was read at.
pub fn delete_person(
    client: &EwsClient,
    db: &Mutex<Connection>,
    target: &Target,
    stored: &store::SyncedPerson,
    read_at: &str,
    now: i64,
) -> Result<PersonWrite> {
    let person_id = target.origin.person_id(&stored.person.uid);
    match client.delete_contact(&stored.person.uid, read_at)? {
        ListWrite::Saved { .. } => {
            store::forget_person(&lock(db), &person_id)?;
            Ok(PersonWrite::Deleted)
        }
        ListWrite::Conflict => {
            let current = client.read_contact(&stored.person.uid)?;
            person_conflict(db, &target.origin, &person_id, current, now)
        }
    }
}

// ---- Lists -------------------------------------------------------------------

/// Records one list as the server now holds it, after a write there.
fn record_list(conn: &Connection, origin: &BookOrigin, list: &DistributionList, now: i64) -> Result<String> {
    contact_groups::put_synced_group_labelled(conn, origin, &group_row(list), &labels(origin, list), now)
}

/// A conflict, with the copy on the server now kept here as the version to
/// look at again and retry from; a list gone from the server goes here too.
fn conflict_recorded(
    db: &Mutex<Connection>,
    origin: &BookOrigin,
    stored: &contact_groups::StoredGroup,
    current: Option<DistributionList>,
    now: i64,
) -> Result<GroupWrite> {
    let conn = lock(db);
    match &current {
        Some(list) => {
            record_list(&conn, origin, list, now)?;
        }
        None => contact_groups::forget_group(&conn, &stored.id)?,
    }
    Ok(conflict(origin, current))
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

/// Creates a list in the folder of `target` (`stored` absent) or renames one
/// and sets its members, from the version it was read at. `wanted` holds
/// person ids of this book.
#[allow(clippy::too_many_arguments)]
pub fn save_group(
    client: &EwsClient,
    db: &Mutex<Connection>,
    target: &Target,
    stored: Option<&contact_groups::StoredGroup>,
    read_at: &str,
    name: &str,
    wanted: &[String],
    now: i64,
) -> Result<GroupWrite> {
    let origin = &target.origin;
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
        let (id, _) = client.create_list(&target.folder, name, &new)?;
        let list = client.read_list(&id)?.context("Exchange did not keep the list it created")?;
        let group = record_list(&lock(db), origin, &list, now)?;
        return Ok(GroupWrite::Saved { id: group, version: list.change_key });
    };
    let Some(server) = client.read_list(&stored.uid)? else {
        return conflict_recorded(db, origin, stored, None, now);
    };
    if server.change_key != read_at {
        return conflict_recorded(db, origin, stored, Some(server), now);
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
        ListWrite::Conflict => {
            let current = client.read_list(&stored.uid)?;
            conflict_recorded(db, origin, stored, current, now)
        }
        ListWrite::Saved { .. } => {
            let list = client.read_list(&stored.uid)?.context("the list is gone from the server")?;
            let id = record_list(&lock(db), origin, &list, now)?;
            Ok(GroupWrite::Saved { id, version: list.change_key })
        }
    }
}

/// Deletes a list from the version it was read at. Its members stay.
pub fn delete_group(
    client: &EwsClient,
    db: &Mutex<Connection>,
    target: &Target,
    stored: &contact_groups::StoredGroup,
    read_at: &str,
    now: i64,
) -> Result<GroupWrite> {
    match client.delete_list(&stored.uid, read_at)? {
        ListWrite::Saved { .. } => {
            contact_groups::forget_group(&lock(db), &stored.id)?;
            Ok(GroupWrite::Deleted)
        }
        ListWrite::Conflict => {
            let current = client.read_list(&stored.uid)?;
            conflict_recorded(db, &target.origin, stored, current, now)
        }
    }
}

#[cfg(test)]
mod tests;
