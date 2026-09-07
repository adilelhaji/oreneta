//! Shared mailbox listing for both frontends. Desktop (`messages.recent` in the
//! sidecar) and mobile (`mail.threadList` over FFI) answer the same question —
//! which cards belong in this mailbox view — and differ only in how they reach a
//! page of headers: desktop may go live over IMAP, mobile answers from the
//! encrypted cache so the list still works offline. The view's inputs, the
//! filter-to-source decision and the response shape live here so a fix for one
//! frontend is a fix for both; platform callers keep only the fetch itself and
//! whatever background sync they spawn afterwards.

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::Connection;
use serde_json::{Value, json};

use crate::imap::MessageHeader;
use crate::{mail_model, rss, store};

/// Default page size when a caller does not ask for one.
pub const DEFAULT_LIMIT: u32 = 50;

/// The mailbox-view inputs, as both transports send them. Only the folder key
/// differs between the two param vocabularies ("folder" vs "folder_id").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadListQuery {
    pub folder: String,
    pub query: String,
    pub filter: String,
    pub before_cursor: Option<PageCursor>,
    pub search_before_cursor: Option<SearchCursor>,
    pub limit: u32,
    /// How the reader asked for it, verbatim; read through [`Self::sort`].
    pub sort: String,
}

/// Where a page of a list left off.
///
/// Carries both a date and a text key because a list can be ordered by either,
/// and the row after the last one shown is found by comparing whichever the
/// ordering used. A position that only knew the date would page correctly in
/// one ordering and silently repeat or skip rows in the others.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PageCursor {
    pub date: i64,
    pub text: String,
    pub uid: u32,
}

/// A globally ordered search position. UIDs are only unique within a folder, so
/// the folder is the final key when Inbox and Sent are merged into one page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchCursor {
    pub date: i64,
    pub uid: u32,
    pub folder: String,
    /// Legacy progressive-scan position, retained so an in-flight cursor minted
    /// by the previous release can fall back to cached keyset paging.
    pub scanned: u32,
    /// Stable live-result snapshot and next position. Absent on cache-only
    /// cursors and cursors minted by versions before search snapshots.
    pub snapshot: Option<String>,
    pub offset: u32,
}

impl ThreadListQuery {
    pub fn from_params(params: &Value, folder_key: &str) -> Self {
        let folder = params
            .get(folder_key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(mail_model::canon_folder)
            .unwrap_or_else(|| "INBOX".to_string());
        Self {
            folder,
            query: params
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            filter: params
                .get("filter")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            before_cursor: params
                .get("before_cursor")
                .and_then(Value::as_str)
                .and_then(parse_mail_cursor),
            search_before_cursor: params
                .get("before_cursor")
                .and_then(Value::as_str)
                .and_then(parse_search_cursor),
            limit: params
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|limit| u32::try_from(limit).ok())
                .filter(|limit| *limit > 0)
                .unwrap_or(DEFAULT_LIMIT),
            sort: params
                .get("sort")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }
    }

    /// Which page the (filter, query) pair asks for.
    ///
    /// The filter is a set, written comma-separated: a reader can ask for what
    /// is both unread and starred, and that is one question with one answer,
    /// not a page of fifty narrowed afterwards to three rows.
    ///
    /// Two of the names are not refinements but different questions, and stay
    /// whole views of their own: `snoozed` reads what has been set aside, and
    /// `starred` on its own is the starred view the side navigation offers.
    /// Only when starred is asked for *alongside* something else does it
    /// become a narrowing of the ordinary page.
    pub fn source(&self) -> MailSource {
        if !self.query.is_empty() {
            return MailSource::Search;
        }
        let names: Vec<&str> = self
            .filter
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty() && *name != "all")
            .collect();
        if names.iter().any(|name| *name == "snoozed") {
            return MailSource::Snoozed;
        }
        if names == ["starred"] {
            return MailSource::Starred;
        }
        MailSource::Recent {
            unread_only: names.contains(&"unread"),
            starred_only: names.contains(&"starred"),
            label_id: names
                .iter()
                .find_map(|name| name.strip_prefix("label:"))
                .filter(|id| !id.is_empty())
                .map(str::to_owned),
            with_attachments: names.contains(&"attachments"),
            priority_only: names.contains(&"priority"),
        }
    }

    /// How the reader has asked the list to be ordered.
    pub fn sort(&self) -> Sort {
        Sort::parse(&self.sort)
    }

    /// Whether this request should also kick off a server sync: only the first
    /// page of an unfiltered, unsearched view — the other sources are answered
    /// by their own live call or are cheap local reads.
    pub fn wants_background_sync(&self) -> bool {
        self.before_cursor.is_none() && matches!(self.source(), MailSource::Recent { .. })
    }
}

/// Where a mail page comes from. Both frontends map filters to the same source;
/// what each source *reads* (live IMAP vs the local cache) is theirs to decide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailSource {
    /// Starred-only view, unpaginated.
    Starred,
    /// Threads put aside, with the ones due back soonest first. Unpaginated:
    /// what someone has set aside is a short list by nature, and a long one is
    /// a sign they need to see all of it.
    Snoozed,
    /// Newest-first page, cursor paged, narrowed by any combination of the
    /// facets a reader can ask for.
    Recent {
        unread_only: bool,
        starred_only: bool,
        /// A label the reader has made, named as `label:<id>` in the filter.
        label_id: Option<String>,
        with_attachments: bool,
        priority_only: bool,
    },
    /// Text search across the folder plus Sent, cursor-paginated.
    Search,
}

/// What a list is ordered by.
///
/// Sorting has to happen in the query, not over the page that came back:
/// ordering fifty loaded rows by sender would put them in order among
/// themselves and in no order at all with respect to the mailbox, which looks
/// like sorting and is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SortKey {
    #[default]
    Date,
    Sender,
    Subject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SortDir {
    #[default]
    Desc,
    Asc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Sort {
    pub key: SortKey,
    pub dir: SortDir,
}

impl Sort {
    /// Reads `date`, `sender` or `subject`, each optionally suffixed `:asc`.
    /// Anything else is the default — newest first, which is what a mailbox
    /// means when nobody has said otherwise.
    pub fn parse(value: &str) -> Self {
        let (key, dir) = value.split_once(':').unwrap_or((value, "desc"));
        Sort {
            key: match key.trim().to_ascii_lowercase().as_str() {
                "sender" | "from" => SortKey::Sender,
                "subject" => SortKey::Subject,
                _ => SortKey::Date,
            },
            dir: if dir.trim().eq_ignore_ascii_case("asc") {
                SortDir::Asc
            } else {
                SortDir::Desc
            },
        }
    }

    /// Whether this is the ordering the store has always used.
    pub fn is_default(&self) -> bool {
        *self == Sort::default()
    }

    /// The column the rows are ordered by, as SQL.
    ///
    /// The sender is the name when there is one and the address otherwise,
    /// which is what the list shows and therefore what someone sorting by
    /// sender is looking at.
    pub fn column(&self) -> &'static str {
        match self.key {
            SortKey::Date => "date",
            SortKey::Sender => "lower(COALESCE(NULLIF(from_name, ''), from_addr, ''))",
            SortKey::Subject => "lower(COALESCE(subject, ''))",
        }
    }

    pub fn sql_dir(&self) -> &'static str {
        match self.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        }
    }

    /// The comparison a cursor uses to find the row after the last one shown.
    pub fn cursor_op(&self) -> &'static str {
        match self.dir {
            SortDir::Asc => ">",
            SortDir::Desc => "<",
        }
    }
}

/// `date:<date>:<uid>` keyset cursor, as minted by [`store::get_recent_page`].
pub fn parse_mail_cursor(cursor: &str) -> Option<PageCursor> {
    // The original shape, still minted for the default ordering so a cursor in
    // flight across an upgrade keeps working.
    if let Some(rest) = cursor.strip_prefix("date:") {
        let (date, uid) = rest.split_once(':')?;
        return Some(PageCursor {
            date: date.parse().ok()?,
            text: String::new(),
            uid: uid.parse().ok()?,
        });
    }
    // `sortk:<base64 text>:<uid>` for the orderings whose key is text. The
    // value is encoded because a subject can contain anything, colons
    // included.
    let rest = cursor.strip_prefix("sortk:")?;
    let (encoded, uid) = rest.rsplit_once(':')?;
    let text = String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    Some(PageCursor {
        date: 0,
        text,
        uid: uid.parse().ok()?,
    })
}

/// The position after the last row of a page, in the shape its ordering reads.
pub fn format_page_cursor(sort: Sort, text_key: &str, date: i64, uid: u32) -> String {
    match sort.key {
        SortKey::Date => format!("date:{date}:{uid}"),
        _ => format!("sortk:{}:{uid}", URL_SAFE_NO_PAD.encode(text_key.as_bytes())),
    }
}

/// `search:<date>:<uid>:<scanned>:<base64-folder>` cursor for a merged page.
pub fn parse_search_cursor(cursor: &str) -> Option<SearchCursor> {
    if let Some(rest) = cursor.strip_prefix("search2:") {
        let mut parts = rest.splitn(5, ':');
        let date = parts.next()?.parse().ok()?;
        let uid = parts.next()?.parse().ok()?;
        let offset = parts.next()?.parse().ok()?;
        let snapshot = String::from_utf8(URL_SAFE_NO_PAD.decode(parts.next()?).ok()?).ok()?;
        let folder = String::from_utf8(URL_SAFE_NO_PAD.decode(parts.next()?).ok()?).ok()?;
        return Some(SearchCursor {
            date,
            uid,
            folder,
            scanned: 0,
            snapshot: Some(snapshot),
            offset,
        });
    }
    let rest = cursor.strip_prefix("search:")?;
    let mut parts = rest.splitn(4, ':');
    let date = parts.next()?.parse().ok()?;
    let uid = parts.next()?.parse().ok()?;
    let scanned = parts.next()?.parse().ok()?;
    let folder = String::from_utf8(URL_SAFE_NO_PAD.decode(parts.next()?).ok()?).ok()?;
    Some(SearchCursor {
        date,
        uid,
        folder,
        scanned,
        snapshot: None,
        offset: 0,
    })
}

pub fn format_search_cursor(cursor: &SearchCursor) -> String {
    if let Some(snapshot) = &cursor.snapshot {
        return format!(
            "search2:{}:{}:{}:{}:{}",
            cursor.date,
            cursor.uid,
            cursor.offset,
            URL_SAFE_NO_PAD.encode(snapshot.as_bytes()),
            URL_SAFE_NO_PAD.encode(cursor.folder.as_bytes())
        );
    }
    format!(
        "search:{}:{}:{}:{}",
        cursor.date,
        cursor.uid,
        cursor.scanned,
        URL_SAFE_NO_PAD.encode(cursor.folder.as_bytes())
    )
}

/// Feed accounts: one card per subscription, filtered like a mail folder.
pub fn rss_page(conn: &Connection, account: &str, query: &ThreadListQuery) -> Result<Value> {
    let threads = rss::recent(
        conn,
        account,
        &query.query,
        &query.filter,
        query.limit as i64,
    )?;
    let folder_unread = rss::unread_count(conn, account)?;
    Ok(json!({ "threads": threads, "folder_unread": folder_unread }))
}

/// Mail accounts: shape a fetched header page into the bridge payload.
///
/// `group` is what thread-list callers want — core grouping (subject branching,
/// root titles, accumulated unread counts) into ready cards. Other consumers
/// (mobile is always a thread list; the desktop chat view is not) keep the raw
/// rows under "messages".
pub fn mail_page(
    conn: &Connection,
    account: &str,
    folder: &str,
    mut messages: Vec<MessageHeader>,
    next_cursor: Option<String>,
    group: bool,
    // Whether threads put aside should be left out. False for the view whose
    // whole purpose is to show them.
    hide_snoozed: bool,
) -> Result<Value> {
    // Rewrite each card's identity to the correspondent so a thread shows the
    // same person/avatar in every folder (outbound copies show the recipient).
    store::apply_card_identity(conn, account, folder, &mut messages);
    let folder_unread = store::get_folder_unread(conn, account, folder)?;
    // A folder row can exist before its first header sync. Keep that distinct
    // from a completed sync that found no messages.
    let folder_synced = store::get_folder_state(conn, account, folder)?.is_some();
    let mut out = if group {
        let draft_thread_keys = store::draft_thread_keys(conn, account)?;
        let threads =
            mail_model::thread_cards_json(conn, account, folder, messages, &draft_thread_keys)?;
        // Threads put aside are left out until their time comes. Filtered on
        // the cards rather than in the query behind them: a thread is put
        // aside as a whole, and the query works in messages.
        let threads: Vec<Value> = if hide_snoozed {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|epoch| epoch.as_secs() as i64)
                .unwrap_or_default();
            let asleep = store::snoozed_thread_keys(conn, account, now)?;
            threads
                .into_iter()
                .filter(|card| {
                    card.get("threadKey")
                        .and_then(Value::as_str)
                        .is_none_or(|key| !asleep.contains(key))
                })
                .collect()
        } else {
            threads
        };
        json!({ "threads": threads, "folder_unread": folder_unread, "folder_synced": folder_synced })
    } else {
        json!({
            "messages": serde_json::to_value(messages)?,
            "folder_unread": folder_unread,
            "folder_synced": folder_synced,
        })
    };
    if let Some(cursor) = next_cursor {
        out.as_object_mut()
            .unwrap()
            .insert("next_cursor".to_string(), Value::String(cursor));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_pick_the_same_source_for_both_frontends() {
        let query = |params: Value| ThreadListQuery::from_params(&params, "folder");
        assert_eq!(
            query(json!({"filter": "all"})).source(),
            MailSource::Recent {
                unread_only: false,
                starred_only: false,
                label_id: None,
                with_attachments: false,
                priority_only: false,
            }
        );
        assert_eq!(
            query(json!({"filter": "unread"})).source(),
            MailSource::Recent {
                unread_only: true,
                starred_only: false,
                label_id: None,
                with_attachments: false,
                priority_only: false,
            }
        );
        assert_eq!(query(json!({"filter": "snoozed"})).source(), MailSource::Snoozed);
        // A search names its own source whatever the filter says, so looking
        // for something does not silently search only what is set aside.
        assert_eq!(
            query(json!({"filter": "snoozed", "query": "factura"})).source(),
            MailSource::Search
        );
        assert_eq!(
            query(json!({"filter": "starred"})).source(),
            MailSource::Starred
        );
        // A search wins over any filter: the source has no filtered variant.
        assert_eq!(
            query(json!({"filter": "starred", "query": "hello"})).source(),
            MailSource::Search
        );
        // A blank search is not a search.
        assert_eq!(
            query(json!({"query": "   "})).source(),
            MailSource::Recent {
                unread_only: false,
                starred_only: false,
                label_id: None,
                with_attachments: false,
                priority_only: false,
            }
        );
    }

    #[test]
    fn filters_asked_for_together_narrow_one_page_rather_than_two() {
        let query = |params: Value| ThreadListQuery::from_params(&params, "folder");

        // One question with one answer. Answering it by filtering a page of
        // fifty afterwards would hand back three rows and call it a page.
        assert_eq!(
            query(json!({"filter": "unread,starred"})).source(),
            MailSource::Recent {
                unread_only: true,
                starred_only: true,
                label_id: None,
                with_attachments: false,
                priority_only: false,
            }
        );
        // Order and spacing are the caller's business, not the meaning's.
        assert_eq!(
            query(json!({"filter": " starred , unread "})).source(),
            MailSource::Recent {
                unread_only: true,
                starred_only: true,
                label_id: None,
                with_attachments: false,
                priority_only: false,
            }
        );
        // "All" alongside something else says nothing, and must not turn the
        // set into the unfiltered page.
        assert_eq!(
            query(json!({"filter": "all,unread"})).source(),
            MailSource::Recent {
                unread_only: true,
                starred_only: false,
                label_id: None,
                with_attachments: false,
                priority_only: false,
            }
        );
        // Starred on its own stays the whole starred view the side navigation
        // offers; only alongside something else is it a narrowing.
        assert_eq!(query(json!({"filter": "starred"})).source(), MailSource::Starred);
        // What has been set aside is a different question, not a refinement,
        // so it stays a view of its own however it is combined.
        assert_eq!(
            query(json!({"filter": "snoozed,unread"})).source(),
            MailSource::Snoozed
        );
        // An empty set is the ordinary page, not an impossible one.
        assert_eq!(
            query(json!({"filter": ",, ,"})).source(),
            MailSource::Recent {
                unread_only: false,
                starred_only: false,
                label_id: None,
                with_attachments: false,
                priority_only: false,
            }
        );
        // A name from a later version is ignored rather than narrowing to
        // nothing: an unknown facet must not empty a mailbox.
        assert_eq!(
            query(json!({"filter": "unread,nonsense"})).source(),
            MailSource::Recent {
                unread_only: true,
                starred_only: false,
                label_id: None,
                with_attachments: false,
                priority_only: false,
            }
        );
    }

    #[test]
    fn params_default_to_the_inbox_and_the_default_page_size() {
        let bare = ThreadListQuery::from_params(&json!({}), "folder_id");
        assert_eq!(bare.folder, "INBOX");
        assert_eq!(bare.limit, DEFAULT_LIMIT);
        assert!(bare.before_cursor.is_none());
        assert!(bare.wants_background_sync());

        let full = ThreadListQuery::from_params(
            &json!({"folder_id": "inbox", "limit": 10, "before_cursor": "date:200:7"}),
            "folder_id",
        );
        assert_eq!(full.folder, "INBOX", "folder names are canonicalized");
        assert_eq!(full.limit, 10);
        assert_eq!(
            full.before_cursor,
            Some(PageCursor { date: 200, text: String::new(), uid: 7 })
        );
        assert!(full.search_before_cursor.is_none());
        assert!(
            !full.wants_background_sync(),
            "paging older never triggers a sync"
        );
    }

    #[test]
    fn search_cursor_round_trips_folder_names() {
        let cursor = SearchCursor {
            date: 200,
            uid: 7,
            folder: "Sent: 日本語".to_string(),
            scanned: 50,
            snapshot: None,
            offset: 0,
        };
        assert_eq!(
            parse_search_cursor(&format_search_cursor(&cursor)),
            Some(cursor.clone())
        );
        let snapshot_cursor = SearchCursor {
            scanned: 0,
            snapshot: Some("opaque token".to_string()),
            offset: 50,
            ..cursor
        };
        assert_eq!(
            parse_search_cursor(&format_search_cursor(&snapshot_cursor)),
            Some(snapshot_cursor)
        );
    }

    #[test]
    fn only_unfiltered_first_pages_ask_for_a_sync() {
        let query = |params: Value| ThreadListQuery::from_params(&params, "folder");
        assert!(query(json!({"filter": "unread"})).wants_background_sync());
        assert!(!query(json!({"filter": "starred"})).wants_background_sync());
        assert!(!query(json!({"query": "hello"})).wants_background_sync());
    }
}
