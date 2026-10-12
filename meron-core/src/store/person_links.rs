//! The same person in two books, linked by the reader (ADR-0012).
//!
//! A link lives only here: it shows two (or more) rows as one person and is
//! undone by unlinking. Nothing is merged, deleted or written on any server,
//! and linking is never automatic: the app suggests people that share an
//! address, and the reader links them or says they are not the same.

use std::collections::{BTreeSet, HashMap};

use anyhow::{bail, Result};
use rusqlite::{params, Connection};

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS person_links (
           person_id TEXT PRIMARY KEY,
           link_id   TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS person_links_link ON person_links(link_id);
         CREATE TABLE IF NOT EXISTS person_link_dismissals (
           a TEXT NOT NULL,
           b TEXT NOT NULL,
           PRIMARY KEY (a, b)
         );",
    )?;
    Ok(())
}

/// Every person's link, by person id.
pub fn links(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT person_id, link_id FROM person_links")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Links these people as one. Any link they already had joins in.
pub fn link(conn: &Connection, ids: &[String]) -> Result<String> {
    let ids: BTreeSet<&String> = ids.iter().collect();
    if ids.len() < 2 {
        bail!("linking needs two people or more");
    }
    let tx = conn.unchecked_transaction()?;
    for id in &ids {
        if !tx.prepare("SELECT 1 FROM people WHERE id = ?1")?.exists(params![id])? {
            bail!("one of those people is no longer in the address book");
        }
    }
    let existing: Vec<String> = {
        let mut found = Vec::new();
        for id in &ids {
            let mut stmt = tx.prepare("SELECT link_id FROM person_links WHERE person_id = ?1")?;
            if let Some(link) = stmt.query_map(params![id], |row| row.get::<_, String>(0))?.next() {
                found.push(link?);
            }
        }
        found
    };
    let link = existing.first().cloned().unwrap_or_else(|| format!("link:{}", uuid::Uuid::new_v4()));
    for other in existing.iter().skip(1) {
        tx.execute("UPDATE person_links SET link_id = ?1 WHERE link_id = ?2", params![link, other])?;
    }
    for id in &ids {
        tx.execute(
            "INSERT OR REPLACE INTO person_links(person_id, link_id) VALUES(?1, ?2)",
            params![id, link],
        )?;
    }
    tx.commit()?;
    Ok(link)
}

/// Takes one person out of their link; a link left with one person ends.
pub fn unlink(conn: &Connection, id: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let link: Option<String> = tx
        .prepare("SELECT link_id FROM person_links WHERE person_id = ?1")?
        .query_map(params![id], |row| row.get(0))?
        .next()
        .transpose()?;
    tx.execute("DELETE FROM person_links WHERE person_id = ?1", params![id])?;
    if let Some(link) = link {
        let left: i64 = tx.query_row("SELECT COUNT(*) FROM person_links WHERE link_id = ?1", params![link], |r| r.get(0))?;
        if left < 2 {
            tx.execute("DELETE FROM person_links WHERE link_id = ?1", params![link])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// "These are not the same person": never suggested together again.
pub fn dismiss(conn: &Connection, ids: &[String]) -> Result<()> {
    for a in ids {
        for b in ids {
            if a < b {
                conn.execute(
                    "INSERT OR IGNORE INTO person_link_dismissals(a, b) VALUES(?1, ?2)",
                    params![a, b],
                )?;
            }
        }
    }
    Ok(())
}

/// Groups of people who share an address and are not linked or dismissed:
/// suggestions for the reader, never acted on alone.
pub fn suggestions(conn: &Connection) -> Result<Vec<Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT a.person_id, b.person_id
           FROM person_emails a
           JOIN person_emails b ON lower(a.addr) = lower(b.addr) AND a.person_id < b.person_id
          WHERE NOT EXISTS (SELECT 1 FROM person_link_dismissals d WHERE d.a = a.person_id AND d.b = b.person_id)
            AND NOT EXISTS (SELECT 1 FROM person_links la JOIN person_links lb ON la.link_id = lb.link_id
                             WHERE la.person_id = a.person_id AND lb.person_id = b.person_id)",
    )?;
    let pairs: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    // Pairs into groups: A~B and B~C is one suggestion of three.
    let mut parent: HashMap<String, String> = HashMap::new();
    fn root(parent: &mut HashMap<String, String>, id: &str) -> String {
        let up = parent.get(id).cloned().unwrap_or_else(|| id.to_string());
        if up == id {
            return up;
        }
        let top = root(parent, &up);
        parent.insert(id.to_string(), top.clone());
        top
    }
    for (a, b) in &pairs {
        parent.entry(a.clone()).or_insert_with(|| a.clone());
        parent.entry(b.clone()).or_insert_with(|| b.clone());
        let (ra, rb) = (root(&mut parent, a), root(&mut parent, b));
        if ra != rb {
            parent.insert(ra, rb);
        }
    }
    let mut groups: HashMap<String, BTreeSet<String>> = HashMap::new();
    let ids: Vec<String> = parent.keys().cloned().collect();
    for id in ids {
        let top = root(&mut parent, &id);
        groups.entry(top).or_default().insert(id);
    }
    let mut out: Vec<Vec<String>> = groups.into_values().map(|set| set.into_iter().collect()).collect();
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests;
