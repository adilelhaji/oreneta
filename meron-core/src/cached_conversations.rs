//! Complete cache-backed Recent candidates for ADR 0003. No transport routes
//! use this service until their cursor/refresh handling is migrated together.

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{Result, bail};
use rusqlite::{Connection, params};
use serde_json::Value;

use crate::conversation_page::{self, Candidate, Scope, View};
use crate::imap::MessageHeader;
use crate::thread_list::{MailSource, ThreadListQuery};
use crate::{mail_model, store, thread_list};

const HEADER_CHUNK: u32 = 1_024;

pub struct FolderState {
    pub account: String,
    pub folder: String,
    pub unread: u32,
    pub synced: bool,
}

pub struct Page {
    pub threads: Vec<Value>,
    pub next_cursor: Option<String>,
    pub folders: Vec<FolderState>,
}

struct LocatedCard {
    scope: Scope,
    card: store::ThreadCard,
}

pub fn recent_filter(request: &ThreadListQuery) -> Option<store::RecentFilter> {
    match request.source() {
        MailSource::Recent { unread_only, starred_only, label_id, with_attachments, priority_only } => {
            Some(store::RecentFilter { unread_only, starred_only, label_id, with_attachments, priority_only })
        }
        _ => None,
    }
}

fn headers(
    conn: &Connection,
    scope: &Scope,
    filter: store::RecentFilter,
) -> Result<Vec<MessageHeader>> {
    let mut out = Vec::new();
    let mut cursor = None;
    loop {
        let (messages, next) = store::get_recent_page(
            conn, &scope.account, &scope.folder, HEADER_CHUNK, cursor, filter.clone(),
        )?;
        out.extend(messages);
        let Some(next) = next else { break };
        cursor = Some(thread_list::parse_mail_cursor(&next)
            .ok_or_else(|| anyhow::anyhow!("invalid internal header continuation"))?);
    }
    Ok(out)
}

fn candidates(
    conn: &Connection,
    scope: &Scope,
    filter: &store::RecentFilter,
    now: i64,
) -> Result<Vec<Candidate<LocatedCard>>> {
    let all = headers(conn, scope, store::RecentFilter::default())?;
    let mut matching = if *filter == store::RecentFilter::default() {
        all.clone()
    } else {
        headers(conn, scope, filter.clone())?
    };
    store::apply_card_identity(conn, &scope.account, &scope.folder, &mut matching);
    let mut representatives: HashMap<String, MessageHeader> = HashMap::new();
    for header in matching {
        if header.uid == 0 { continue; }
        let key = store::card_thread_key(&header);
        match representatives.entry(key) {
            std::collections::hash_map::Entry::Vacant(entry) => { entry.insert(header); }
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                let old = entry.get();
                if (header.date, header.uid) > (old.date, old.uid) { entry.insert(header); }
            }
        }
    }
    let drafts = store::draft_thread_keys(conn, &scope.account)?;
    let asleep: HashSet<_> = store::snoozed_threads(conn, &scope.account)?.into_iter()
        .filter(|(key, folder, until)| *until > now
            && (!store::split_thread_key(key).0.starts_with("uid:")
                || mail_model::canon_folder(folder) == scope.folder))
        .map(|(key, _, _)| key).collect();
    let cards = store::group_thread_cards_with_drafts(all, &scope.folder, &drafts);
    let mut out = Vec::new();
    for mut card in cards {
        if asleep.contains(&card.thread_key)
            || asleep.contains(&store::split_thread_key(&card.thread_key).0)
        {
            continue;
        }
        let Some(mut representative) = representatives.remove(&card.thread_key) else { continue };
        // Root/branch identity and full-folder flags do not depend on which
        // message happened to match a facet or the selected sort direction.
        representative.subject = card.header.subject;
        representative.thread_key = card.thread_key.clone();
        representative.folder = scope.folder.clone();
        representative.starred = card.header.starred;
        representative.seen = card.unread_count == 0;
        card.header = representative;
        let sender = if card.header.from_name.is_empty() {
            &card.header.from_addr
        } else {
            &card.header.from_name
        };
        out.push(Candidate {
            id: mail_model::format_thread_id(&scope.account, &scope.folder, &card.thread_key),
            date: card.header.date,
            sender: sender.clone(),
            subject: card.header.subject.clone(),
            item: LocatedCard { scope: scope.clone(), card },
        });
    }
    Ok(out)
}

/// Read-only, one transaction per response. `scopes` must be resolved mail
/// folders; RSS and non-Recent sources have separate acquisition contracts.
pub fn page(
    conn: &Connection,
    scopes: Vec<Scope>,
    namespace: &str,
    request: &ThreadListQuery,
    before_cursor: Option<&str>,
) -> Result<Page> {
    let filter = recent_filter(request)
        .ok_or_else(|| anyhow::anyhow!("cached conversation paging requires a Recent view"))?;
    let mut scopes: Vec<_> = scopes.into_iter().map(|scope| Scope {
        account: scope.account, folder: mail_model::canon_folder(&scope.folder),
    }).collect();
    scopes.sort();
    scopes.dedup();
    let view = View {
        namespace: namespace.to_string(), scopes: scopes.clone(),
        query: request.query.clone(), filter: request.filter.clone(), sort: request.sort(),
    };
    let tx = conn.unchecked_transaction()?;
    let now = store::now_unix();
    let mut all = Vec::new();
    let mut folders = Vec::new();
    for scope in &scopes {
        let rss: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE id = ?1 AND engine = 'rss')",
            params![scope.account], |row| row.get(0),
        )?;
        if rss { bail!("RSS is not a cached mail conversation source"); }
        all.extend(candidates(&tx, scope, &filter, now)?);
        folders.push(FolderState {
            account: scope.account.clone(), folder: scope.folder.clone(),
            unread: store::get_folder_unread(&tx, &scope.account, &scope.folder)?,
            synced: store::get_folder_state(&tx, &scope.account, &scope.folder)?.is_some(),
        });
    }
    let selected = conversation_page::page(all, &view, request.limit as usize, before_cursor)?;
    let mut order = Vec::new();
    let mut by_scope: BTreeMap<Scope, Vec<store::ThreadCard>> = BTreeMap::new();
    for located in selected.items {
        order.push(mail_model::format_thread_id(
            &located.scope.account, &located.scope.folder, &located.card.thread_key,
        ));
        by_scope.entry(located.scope).or_default().push(located.card);
    }
    let mut enriched = HashMap::new();
    for (scope, cards) in by_scope {
        for card in mail_model::grouped_thread_cards_json(&tx, &scope.account, cards)? {
            let id = card["thread_id"].as_str()
                .ok_or_else(|| anyhow::anyhow!("enriched conversation is missing its identity"))?.to_string();
            enriched.insert(id, card);
        }
    }
    let threads = order.into_iter().map(|id| enriched.remove(&id)
        .ok_or_else(|| anyhow::anyhow!("enrichment lost a selected conversation")))
        .collect::<Result<Vec<_>>>()?;
    tx.commit()?;
    Ok(Page { threads, next_cursor: selected.next_cursor, folders })
}

#[cfg(test)]
mod tests;
