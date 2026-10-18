//! Deleting a profile that holds data (#99, ADR-0016, ADR-0038).
//!
//! A profile's passwords and keys live in the system keychain under names
//! only its own store knows. Before its folders are removed, the core runs
//! once inside that profile, reads the store for every name it keeps there,
//! and deletes each one; the store key goes last, since without it the
//! store cannot be read again.

use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Purged {
    pub secrets: usize,
    pub graph: usize,
}

fn column(conn: &Connection, sql: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every keychain name this profile's store refers to, besides Graph's
/// records and the store key.
pub fn secret_names(conn: &Connection) -> Result<Vec<String>> {
    let mut names = column(conn, "SELECT id FROM accounts")?;
    names.extend(column(conn, "SELECT id FROM contact_sources")?);
    let mut stmt = conn.prepare("SELECT account, provider_id FROM calendars WHERE kind = 'caldav'")?;
    let calendars = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for calendar in calendars {
        let (account, id) = calendar?;
        names.push(crate::calendar::caldav::secret_key(&account, &id));
    }
    names.extend(column(conn, "SELECT id FROM chat_accounts")?.iter().map(|id| crate::chat::secret_key(id)));
    // Room passwords (ADR-0044), of rooms joined and of invitations waiting.
    let mut stmt = conn.prepare(
        "SELECT chat_account, room FROM chat_rooms WHERE has_password = 1
          UNION SELECT chat_account, room FROM chat_invitations WHERE has_password = 1",
    )?;
    let rooms = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for room in rooms {
        let (account, room) = room?;
        names.push(crate::chat::room_secret_key(&account, &room));
    }
    names.extend(column(conn, "SELECT id FROM cloud_accounts")?.iter().map(|id| crate::cloud::secret_key(id)));
    names.extend(column(conn, "SELECT fingerprint FROM pgp_secret_keys")?.iter().map(|f| format!("pgp-secret-{f}")));
    names.extend(
        column(conn, "SELECT fingerprint FROM smime_identities")?.iter().map(|f| format!("smime-identity-{f}")),
    );
    names.extend(
        column(conn, "SELECT id FROM task_lists WHERE remote_url <> ''")?.iter().map(|id| crate::task_sync::secret_key(id)),
    );
    // Passwords of an account's CalDAV lists waiting for a first read (ADR-0070).
    names.extend(crate::task_sync::account_lists::pending_secret_keys(conn)?);
    names.push(crate::backup_schedule::SECRET_KEY.to_string());
    names.sort();
    names.dedup();
    Ok(names)
}

/// Every keychain name this profile's store refers to, Graph's records
/// included and the store key aside: what the start-up sweep moves from the
/// `meron` service to `oreneta` (ADR-0063). The store key is moved when the
/// store opens, before this list can be read.
pub fn keychain_names(conn: &Connection) -> Result<Vec<String>> {
    let mut names = secret_names(conn)?;
    names.extend(column(conn, "SELECT id FROM accounts")?.iter().map(|id| crate::graph::auth::vault_key(id)));
    names.sort();
    names.dedup();
    Ok(names)
}

/// Deletes every keychain entry of the open profile. Run with the profile's
/// own `MERON_PROFILE`, never from another profile's process.
pub fn purge(conn: &Connection) -> Result<Purged> {
    let purged = purge_entries(conn)?;
    crate::secrets::delete_db_key()?;
    Ok(purged)
}

/// Everything but the store key, which tests must never touch.
fn purge_entries(conn: &Connection) -> Result<Purged> {
    let names = secret_names(conn)?;
    for name in &names {
        crate::secrets::delete(name)?;
    }
    let accounts = column(conn, "SELECT id FROM accounts")?;
    let mut graph = 0;
    if !crate::secrets::keyring_off() {
        for account in &accounts {
            crate::graph::auth::delete_record(account)?;
            graph += 1;
        }
    }
    Ok(Purged { secrets: names.len(), graph })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_of_secret_the_store_knows_is_named() {
        let conn = crate::store::open_in_memory_for_test().unwrap();
        conn.execute_batch(
            "INSERT INTO accounts(id, email, display_name, config) VALUES('a@x.cat', 'a@x.cat', 'A', '{}');
             INSERT INTO chat_accounts(id, jid, host, port, created_at) VALUES('c1', 'a@chat', '', 5222, 0);
             INSERT INTO chat_rooms(chat_account, room, nick, has_password, joined_at) VALUES('c1', 'team@rooms.chat', 'a', 1, 0);
             INSERT INTO chat_rooms(chat_account, room, nick, has_password, joined_at) VALUES('c1', 'open@rooms.chat', 'a', 0, 0);
             INSERT INTO chat_invitations(chat_account, room, inviter, reason, has_password, received_at)
               VALUES('c1', 'club@rooms.chat', 'b@chat', '', 1, 0);
             INSERT INTO task_lists(id, name, remote_url) VALUES('list:dav', 'Dav', 'https://dav.example/ana/tasks/');",
        )
        .unwrap();
        let names = secret_names(&conn).unwrap();
        assert!(names.contains(&"a@x.cat".to_string()));
        assert!(names.contains(&crate::chat::secret_key("c1")));
        assert!(names.contains(&crate::chat::room_secret_key("c1", "team@rooms.chat")));
        assert!(names.contains(&crate::chat::room_secret_key("c1", "club@rooms.chat")));
        assert!(!names.contains(&crate::chat::room_secret_key("c1", "open@rooms.chat")), "no password, no secret");
        assert!(names.contains(&crate::backup_schedule::SECRET_KEY.to_string()));
        assert!(names.contains(&crate::task_sync::secret_key("list:dav")));
        assert!(!names.contains(&crate::task_sync::secret_key("mail")), "a local list has no password");
    }

    /// ADR-0070: the password of an account's CalDAV list waiting for its
    /// first read is the profile's too.
    #[test]
    fn a_password_waiting_for_a_first_read_is_named() {
        let conn = crate::store::open_in_memory_for_test().unwrap();
        let source = crate::task_sync::account_lists::collection_source("https://dav.example/ana/tasks/").unwrap();
        conn.execute(
            "INSERT INTO account_task_lists(account, source, state) VALUES('a@x.cat', ?1, 'pending')",
            rusqlite::params![source],
        )
        .unwrap();
        let names = secret_names(&conn).unwrap();
        assert!(names.contains(&crate::task_sync::account_lists::pending_secret_key("a@x.cat", &source)), "{names:?}");
    }

    /// The start-up sweep (ADR-0063) moves what a purge would delete, Graph's
    /// records included, so no entry is left behind under `meron`.
    #[test]
    fn the_sweep_names_every_secret_and_each_accounts_graph_record() {
        let conn = crate::store::open_in_memory_for_test().unwrap();
        conn.execute_batch(
            "INSERT INTO accounts(id, email, display_name, config) VALUES('a@x.cat', 'a@x.cat', 'A', '{}');
             INSERT INTO chat_accounts(id, jid, host, port, created_at) VALUES('c1', 'a@chat', '', 5222, 0);",
        )
        .unwrap();
        let names = keychain_names(&conn).unwrap();
        for name in secret_names(&conn).unwrap() {
            assert!(names.contains(&name), "{name} is swept");
        }
        assert!(names.contains(&crate::graph::auth::vault_key("a@x.cat")));
        let mut sorted = names.clone();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "each name once");
    }

    #[test]
    fn the_profiles_secrets_are_deleted_and_nothing_else() {
        let conn = crate::store::open_in_memory_for_test().unwrap();
        let ours = format!("purge-test-{}@x.cat", uuid::Uuid::new_v4());
        let other = format!("purge-other-{}@x.cat", uuid::Uuid::new_v4());
        conn.execute(
            "INSERT INTO accounts(id, email, display_name, config) VALUES(?1, ?1, 'A', '{}')",
            rusqlite::params![ours],
        )
        .unwrap();
        let secret = crate::secrets::Secrets { password: "pw".into(), ..Default::default() };
        crate::secrets::store(&ours, &secret).unwrap();
        crate::secrets::store(&other, &secret).unwrap();
        let purged = purge_entries(&conn).unwrap();
        assert!(purged.secrets >= 2);
        assert!(crate::secrets::load(&ours).unwrap().password.is_empty());
        assert_eq!(crate::secrets::load(&other).unwrap().password, "pw");
        crate::secrets::delete(&other).unwrap();
    }

    /// A new kind of secret must be added to `secret_names`, or deleting a
    /// profile would leave it behind in the keychain. This counts where
    /// secrets are written; when it changes, check the list above and then
    /// the number here.
    #[test]
    fn a_new_place_that_writes_a_secret_is_noticed() {
        let main = include_str!("main.rs");
        let writes = main.matches("secrets::store(").count();
        assert_eq!(
            writes, 16,
            "a secret is written somewhere new: name it in profile_purge::secret_names, then update this count"
        );
        let graph = include_str!("graph/auth.rs").matches("graph_record_store(").count();
        assert_eq!(graph, 1, "Graph records are deleted per account in profile_purge::purge");
    }
}
