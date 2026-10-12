//! What the reader's sidebar shows about a person (#86): the conversations,
//! files and upcoming meetings shared with one address, in one account.
//!
//! Always one account: what another account holds about the same person is
//! never shown here. Matching is on the whole address, never a part of it
//! (`ana@x.test` is not `diana@x.test`). And what is shown is only what is
//! kept on this computer, which is said with the counts it comes from.

use anyhow::Result;
use rusqlite::{Connection, params};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SharedConversation {
    pub thread_id: String,
    pub folder: String,
    pub subject: String,
    pub date: i64,
    /// Whether the newest message with this person in it was sent by them.
    pub from_them: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SharedEvent {
    pub calendar_id: String,
    pub event_id: String,
    pub subject: String,
    pub start: i64,
    pub end: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PersonContext {
    pub address: String,
    pub conversations: Vec<SharedConversation>,
    pub events: Vec<SharedEvent>,
    pub files: Vec<crate::store::attachment_list::Item>,
    /// Messages kept here for the account, and how many of those have their
    /// body (and so their files) downloaded.
    pub coverage: crate::store::attachment_list::Coverage,
}

fn names(addresses: &[crate::imap::Recipient], wanted: &str) -> bool {
    addresses.iter().any(|r| r.addr.trim().eq_ignore_ascii_case(wanted))
}

/// The person's history with one account, newest first.
pub fn person(conn: &Connection, account: &str, address: &str, now: i64) -> Result<PersonContext> {
    let address = address.trim().to_lowercase();
    anyhow::ensure!(address.contains('@'), "an address is needed");

    // Conversations: a substring narrows, the whole address decides.
    let mut stmt = conn.prepare(
        "SELECT folder, thread_key, uid, COALESCE(subject, ''), date, lower(COALESCE(from_addr, '')),
                json_extract(json, '$.to'), json_extract(json, '$.cc')
           FROM messages
          WHERE account = ?1
            AND (lower(COALESCE(from_addr, '')) = ?2
                 OR instr(lower(COALESCE(json_extract(json, '$.to'), '')), ?2) > 0
                 OR instr(lower(COALESCE(json_extract(json, '$.cc'), '')), ?2) > 0)
          ORDER BY date DESC
          LIMIT 400",
    )?;
    let rows = stmt.query_map(params![account, address], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
        ))
    })?;
    let mut conversations: Vec<SharedConversation> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let (folder, thread_key, uid, subject, date, from, to, cc) = row?;
        let from_them = from == address;
        let named = from_them
            || names(&crate::store::parse_recipients_json(to), &address)
            || names(&crate::store::parse_recipients_json(cc), &address);
        if !named {
            continue;
        }
        let thread_id = match thread_key.filter(|k| !k.is_empty()) {
            Some(key) => crate::mail_model::format_thread_id(account, &folder, &key),
            None => format!("{account}#{folder}#{uid}"),
        };
        if seen.insert(thread_id.clone()) {
            conversations.push(SharedConversation { thread_id, folder, subject, date, from_them });
        }
        if conversations.len() >= 10 {
            break;
        }
    }

    // Upcoming meetings they are on, as organizer or attendee.
    let mut stmt = conn.prepare(
        "SELECT calendar_id, event_id, COALESCE(subject, ''), start_utc, end_utc, organizer, attendees
           FROM calendar_events
          WHERE account = ?1 AND end_utc > ?2 AND is_cancelled = 0
            AND (instr(lower(COALESCE(organizer, '')), ?3) > 0 OR instr(lower(COALESCE(attendees, '')), ?3) > 0)
          ORDER BY start_utc
          LIMIT 50",
    )?;
    let rows = stmt.query_map(params![account, now, address], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut events = Vec::new();
    for row in rows {
        let (calendar_id, event_id, subject, start, end, organizer, attendees) = row?;
        let organizer: Option<crate::calendar::Participant> =
            organizer.and_then(|json| serde_json::from_str(&json).ok());
        let attendees: Vec<crate::calendar::Participant> =
            attendees.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
        let on_it = organizer.iter().chain(attendees.iter()).any(|p| p.addr.trim().eq_ignore_ascii_case(&address));
        if on_it {
            events.push(SharedEvent { calendar_id, event_id, subject, start, end });
        }
        if events.len() >= 5 {
            break;
        }
    }

    // Files they sent, from the same list the attachments view reads.
    let page = crate::store::attachment_list::list(
        conn,
        &crate::store::attachment_list::Query {
            account: account.to_string(),
            sender: address.clone(),
            limit: Some(50),
            ..Default::default()
        },
    )?;
    let files = page
        .items
        .into_iter()
        .filter(|item| item.from_addr.trim().eq_ignore_ascii_case(&address))
        .take(10)
        .collect();

    Ok(PersonContext { address, conversations, events, files, coverage: page.coverage })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Connection {
        crate::store::open_in_memory_for_test().unwrap()
    }

    fn message(conn: &Connection, account: &str, uid: i64, from: &str, to: &[&str], subject: &str, date: i64, thread: &str) {
        let to: Vec<serde_json::Value> = to.iter().map(|a| serde_json::json!({ "name": "", "addr": a })).collect();
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, thread_key, json)
             VALUES(?1, 'INBOX', ?2, ?3, ?4, '', ?5, ?6, ?7, ?8)",
            params![
                account,
                uid.to_string(),
                uid,
                subject,
                from,
                date,
                thread,
                serde_json::json!({ "to": to }).to_string()
            ],
        )
        .unwrap();
    }

    #[test]
    fn a_persons_conversations_are_theirs_in_this_account_only_and_by_whole_address() {
        let c = store();
        message(&c, "work", 1, "ana@x.test", &["me@work.test"], "Budget", 100, "t1");
        message(&c, "work", 2, "me@work.test", &["ana@x.test"], "Re: Budget", 200, "t1");
        message(&c, "work", 3, "me@work.test", &["diana@x.test"], "Not Ana", 300, "t2");
        message(&c, "work", 4, "bob@x.test", &["me@work.test", "Ana@X.test"], "Trip", 150, "t3");
        message(&c, "home", 5, "ana@x.test", &["me@home.test"], "Family", 400, "t4");
        let got = person(&c, "work", " ANA@x.test ", 0).unwrap();
        let subjects: Vec<&str> = got.conversations.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["Re: Budget", "Trip"], "one per thread, newest first, no Diana, no other account");
        assert!(!got.conversations[0].from_them);
        assert_eq!(got.address, "ana@x.test");
        assert!(person(&c, "work", "nobody", 0).is_err());
    }

    #[test]
    fn upcoming_meetings_with_them_and_nothing_past_or_cancelled() {
        let c = store();
        let add = |id: &str, start: i64, cancelled: i64, attendees: &str| {
            c.execute(
                "INSERT INTO calendar_events(account, calendar_id, event_id, subject, start_utc, end_utc, all_day,
                   is_recurring, is_cancelled, free_busy, my_response, attendees)
                 VALUES('work', 'cal', ?1, ?1, ?2, ?3, 0, 0, ?4, 'busy', '', ?5)",
                params![id, start, start + 3600, cancelled, attendees],
            )
            .unwrap();
        };
        add("future", 10_000, 0, r#"[{"name":"Ana","addr":"ana@x.test","response":""}]"#);
        add("past", 10, 0, r#"[{"name":"Ana","addr":"ana@x.test","response":""}]"#);
        add("cancelled", 20_000, 1, r#"[{"name":"Ana","addr":"ana@x.test","response":""}]"#);
        add("diana", 30_000, 0, r#"[{"name":"Diana","addr":"diana@x.test","response":""}]"#);
        let got = person(&c, "work", "ana@x.test", 5_000).unwrap();
        let ids: Vec<&str> = got.events.iter().map(|e| e.event_id.as_str()).collect();
        assert_eq!(ids, ["future"]);
        assert!(person(&c, "home", "ana@x.test", 5_000).unwrap().events.is_empty());
    }
}
