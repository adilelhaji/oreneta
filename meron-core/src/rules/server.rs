//! Which of the reader's rules run on an account's server (#94, ADR-0027).
//!
//! Recorded when Oreneta's script is stored and active there, so the same
//! rules are not applied a second time here. A script stored but not active
//! (another script is) runs nothing, and the rules keep running here.

use std::collections::HashSet;

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS server_rules (
  account     TEXT PRIMARY KEY,
  script_hash TEXT NOT NULL,
  included    TEXT NOT NULL DEFAULT '[]',
  active      INTEGER NOT NULL,
  pushed_at   INTEGER NOT NULL
);
";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub script_hash: String,
    pub included: Vec<String>,
    pub active: bool,
    pub pushed_at: i64,
}

pub fn state(conn: &Connection, account: &str) -> Result<Option<State>> {
    Ok(conn
        .query_row(
            "SELECT script_hash, included, active, pushed_at FROM server_rules WHERE account = ?1",
            [account],
            |r| {
                Ok(State {
                    script_hash: r.get(0)?,
                    included: serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or_default(),
                    active: r.get(2)?,
                    pushed_at: r.get(3)?,
                })
            },
        )
        .optional()?)
}

pub fn save(conn: &Connection, account: &str, state: &State) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO server_rules(account, script_hash, included, active, pushed_at)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        params![account, state.script_hash, serde_json::to_string(&state.included)?, state.active, state.pushed_at],
    )?;
    Ok(())
}

pub fn clear(conn: &Connection, account: &str) -> Result<()> {
    conn.execute("DELETE FROM server_rules WHERE account = ?1", [account])?;
    Ok(())
}

/// The rules the server applies for this account, which are not applied here.
pub fn on_server(conn: &Connection, account: &str) -> HashSet<String> {
    match state(conn, account) {
        Ok(Some(state)) if state.active => state.included.into_iter().collect(),
        _ => HashSet::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_active_script_takes_rules_off_this_computer() {
        let conn = Connection::open_in_memory().unwrap();
        crate::store::run_migrations(&conn).unwrap();
        assert!(on_server(&conn, "acct").is_empty());
        let stored = State { script_hash: "h".into(), included: vec!["r1".into()], active: false, pushed_at: 1 };
        save(&conn, "acct", &stored).unwrap();
        assert!(on_server(&conn, "acct").is_empty(), "stored but another script is active: nothing runs there");
        save(&conn, "acct", &State { active: true, ..stored }).unwrap();
        assert_eq!(on_server(&conn, "acct"), HashSet::from(["r1".to_string()]));
        assert!(on_server(&conn, "other").is_empty(), "per account");
        clear(&conn, "acct").unwrap();
        assert!(on_server(&conn, "acct").is_empty());
    }
}
