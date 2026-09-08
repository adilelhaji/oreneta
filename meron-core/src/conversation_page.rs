//! Conversation-level ordering shared by mailbox adapters. See ADR 0003.
//!
//! Input must contain the complete eligible card set, already grouped with a
//! deterministic representative and displayed identity. A message page is not
//! a valid input. This module does not fetch messages or activate any route.

use std::{cmp::Ordering, collections::HashSet};

use anyhow::{Result, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::thread_list::{Sort, SortDir, SortKey};

const CURSOR_PREFIX: &str = "conv1:";
pub const RELOAD_REQUIRED: &str = "conversation cursor invalid for this view; reload the first page";

/// Resolved scopes, not provider-independent role names alone. Membership or
/// role-to-folder changes must invalidate an existing unified continuation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Scope {
    pub account: String,
    pub folder: String,
}

pub struct View {
    /// Includes source and logical scope, e.g. `recent:unified:inbox`.
    pub namespace: String,
    pub scopes: Vec<Scope>,
    pub query: String,
    pub filter: String,
    pub sort: Sort,
}

impl View {
    fn digest(&self) -> Result<String> {
        if self.namespace.is_empty()
            || self.scopes.iter().any(|scope| scope.account.is_empty() || scope.folder.is_empty())
        {
            bail!("conversation view requires a namespace and qualified scopes");
        }
        let mut scopes: Vec<_> = self.scopes.iter().collect();
        scopes.sort_unstable();
        scopes.dedup();
        let mut filters: Vec<_> = self.filter.split(',').map(str::trim)
            .filter(|facet| !facet.is_empty() && *facet != "all").collect();
        filters.sort_unstable();
        filters.dedup();
        let key = match self.sort.key {
            SortKey::Date => "date",
            SortKey::Sender => "sender",
            SortKey::Subject => "subject",
        };
        let direction = match self.sort.dir {
            SortDir::Asc => "asc",
            SortDir::Desc => "desc",
        };
        let context = serde_json::to_vec(&(
            CURSOR_PREFIX, &self.namespace, scopes, self.query.trim(), filters, key, direction,
        ))?;
        Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(context)))
    }
}

/// Keys must describe the displayed card, not its raw message envelope.
pub struct Candidate<T> {
    pub id: String,
    pub date: i64,
    pub sender: String,
    pub subject: String,
    pub item: T,
}

pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", deny_unknown_fields)]
enum Key {
    Date(i64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    key: Key,
    id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    context: String,
    position: Position,
}

fn compare(left: &Position, right: &Position, direction: SortDir) -> Ordering {
    match direction {
        SortDir::Asc => left.cmp(right),
        SortDir::Desc => right.cmp(left),
    }
}

fn decode_cursor(raw: &str, context: &str, sort: Sort) -> Result<Position> {
    let decoded = raw.strip_prefix(CURSOR_PREFIX)
        .and_then(|body| URL_SAFE_NO_PAD.decode(body).ok())
        .and_then(|bytes| serde_json::from_slice::<Cursor>(&bytes).ok());
    match decoded {
        Some(cursor) if cursor.context == context && !cursor.position.id.is_empty()
            && matches!((&cursor.position.key, sort.key),
                (Key::Date(_), SortKey::Date)
                | (Key::Text(_), SortKey::Sender | SortKey::Subject)) => Ok(cursor.position),
        _ => bail!(RELOAD_REQUIRED),
    }
}

/// One limit across all supplied account/folder-qualified cards. A cursor is
/// not a snapshot: concurrent card movement can cross its boundary (ADR 0003).
pub fn page<T>(
    candidates: Vec<Candidate<T>>,
    view: &View,
    limit: usize,
    before_cursor: Option<&str>,
) -> Result<Page<T>> {
    if limit == 0 {
        bail!("conversation page limit must be positive");
    }
    let context = view.digest()?;
    let before = before_cursor.map(|raw| decode_cursor(raw, &context, view.sort)).transpose()?;
    let mut ids = HashSet::with_capacity(candidates.len());
    let mut ordered = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if candidate.id.is_empty() || !ids.insert(candidate.id.clone()) {
            bail!("conversation candidates require unique nonempty qualified identities");
        }
        let position = Position {
            key: match view.sort.key {
                SortKey::Date => Key::Date(candidate.date),
                SortKey::Sender => Key::Text(candidate.sender.to_ascii_lowercase()),
                SortKey::Subject => Key::Text(candidate.subject.to_ascii_lowercase()),
            },
            id: candidate.id,
        };
        if before.as_ref().is_none_or(|before| compare(&position, before, view.sort.dir).is_gt()) {
            ordered.push((position, candidate.item));
        }
    }
    ordered.sort_unstable_by(|(left, _), (right, _)| compare(left, right, view.sort.dir));
    let has_more = ordered.len() > limit;
    ordered.truncate(limit);
    let next_cursor = if has_more {
        // A positive limit and has_more guarantee a final row.
        let (position, _) = ordered.last().expect("nonempty conversation page");
        Some(format!("{CURSOR_PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(
            &Cursor { context, position: position.clone() },
        )?)))
    } else {
        None
    };
    Ok(Page { items: ordered.into_iter().map(|(_, item)| item).collect(), next_cursor })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(sort: &str) -> View {
        View {
            namespace: "recent:unified:inbox".into(),
            scopes: vec![Scope { account: "a".into(), folder: "INBOX".into() },
                Scope { account: "b".into(), folder: "INBOX".into() }],
            query: String::new(), filter: "all".into(), sort: Sort::parse(sort),
        }
    }

    fn row(id: &str, date: i64, sender: &str, subject: &str) -> Candidate<String> {
        Candidate { id: id.into(), date, sender: sender.into(), subject: subject.into(), item: id.into() }
    }

    fn rows() -> Vec<Candidate<String>> {
        vec![
            row("a#INBOX#1", 1, "Alice", "Zebra"),
            row("b#INBOX#1", 1, "alice", "zebra"),
            row("a#INBOX#2", i64::MIN, "", ""),
            row("a#INBOX#3", i64::MAX, " Bob", " alpha"),
            row("a#INBOX#4", 2, "É", "é"),
            row("a#INBOX#5", 3, "é", "É"),
        ]
    }

    #[test]
    fn all_sorts_have_declared_order_not_input_order() {
        let fixtures = [
            ("date", vec!["a#INBOX#3", "a#INBOX#5", "a#INBOX#4", "b#INBOX#1", "a#INBOX#1", "a#INBOX#2"]),
            ("sender", vec!["a#INBOX#5", "a#INBOX#4", "b#INBOX#1", "a#INBOX#1", "a#INBOX#3", "a#INBOX#2"]),
            ("subject", vec!["a#INBOX#4", "a#INBOX#5", "b#INBOX#1", "a#INBOX#1", "a#INBOX#3", "a#INBOX#2"]),
        ];
        for (key, expected) in fixtures {
            for direction in ["desc", "asc"] {
                let mut expected = expected.clone();
                if direction == "asc" { expected.reverse(); }
                let view = view(&format!("{key}:{direction}"));
                for reverse in [false, true] {
                    let mut input = rows();
                    if reverse { input.reverse(); }
                    let result = page(input, &view, usize::MAX, None).unwrap();
                    assert_eq!(result.items, expected, "{key}:{direction}");
                    assert!(result.next_cursor.is_none());
                }
            }
        }
    }

    #[test]
    fn stable_traversal_is_complete_for_all_sorts_and_page_sizes() {
        for key in ["date", "sender", "subject"] {
            for direction in ["desc", "asc"] {
                let view = view(&format!("{key}:{direction}"));
                let expected = page(rows(), &view, 100, None).unwrap().items;
                for size in 1..=7 {
                    let mut cursor = None;
                    let mut actual = Vec::new();
                    for attempt in 0..=6 {
                        let result = page(rows(), &view, size, cursor.as_deref()).unwrap();
                        actual.extend(result.items);
                        cursor = result.next_cursor;
                        if cursor.is_none() { break; }
                        assert!(attempt < 6, "cursor must terminate");
                    }
                    assert_eq!(actual, expected, "{key}:{direction} size={size}");
                    assert_eq!(actual.iter().collect::<HashSet<_>>().len(), actual.len());
                }
            }
        }
    }

    #[test]
    fn cursor_is_opaque_and_page_size_can_change() {
        let view = view("sender:asc");
        let first = page(rows(), &view, 1, None).unwrap();
        let cursor = first.next_cursor.unwrap();
        assert!(cursor.starts_with(CURSOR_PREFIX));
        let rest = page(rows(), &view, 100, Some(&cursor)).unwrap();
        let actual: Vec<_> = first.items.into_iter().chain(rest.items).collect();
        assert_eq!(actual, page(rows(), &view, 100, None).unwrap().items);
        assert!(rest.next_cursor.is_none());
    }

    #[test]
    fn normalized_context_accepts_equivalent_scope_facet_and_sort_inputs() {
        let mut original = view("sender:asc");
        original.query = "  from:alice  ".into();
        original.filter = "unread,attachments".into();
        let first = page(rows(), &original, 1, None).unwrap();
        let mut equivalent = view(" FROM : ASC ");
        equivalent.query = "from:alice".into();
        equivalent.filter = " all, attachments, unread, unread, ".into();
        equivalent.scopes.reverse();
        equivalent.scopes.push(equivalent.scopes[0].clone());
        assert_eq!(original.digest().unwrap(), equivalent.digest().unwrap());
        assert!(page(rows(), &equivalent, 2, first.next_cursor.as_deref()).is_ok());
    }

    #[test]
    fn cursor_rejects_each_changed_context_dimension() {
        let original = view("date:desc");
        let cursor = page(rows(), &original, 1, None).unwrap().next_cursor.unwrap();
        for change in 0..8 {
            let mut changed = view("date:desc");
            match change {
                0 => changed.namespace = "search:unified:inbox".into(),
                1 => changed.scopes[0].account = "c".into(),
                2 => changed.scopes[0].folder = "Sent".into(),
                3 => { changed.scopes.pop(); },
                4 => changed.query = "test".into(),
                5 => changed.filter = "unread".into(),
                6 => changed.sort = Sort::parse("date:asc"),
                _ => changed.sort = Sort::parse("sender:desc"),
            }
            assert_eq!(page(rows(), &changed, 1, Some(&cursor)).err().unwrap().to_string(), RELOAD_REQUIRED);
        }
    }

    #[test]
    fn malformed_legacy_and_wrong_key_cursors_fail_without_a_page() {
        let view = view("date:desc");
        let context = view.digest().unwrap();
        let mut cursors = vec!["".into(), "date:1:1".into(), "sortk:YWJj:1".into(),
            "conv2:abc".into(), "conv1:***".into(), "conv1:e30".into()];
        for value in [
            serde_json::json!({"context": context, "position": {"key": {"kind": "Text", "value": "wrong"}, "id": "a#INBOX#1"}}),
            serde_json::json!({"context": context, "position": {"key": {"kind": "Date", "value": 1}, "id": ""}}),
            serde_json::json!({"context": context, "position": {"key": {"kind": "Date", "value": 1}, "id": "a"}, "extra": true}),
            serde_json::json!({"context": context, "position": {"key": {"kind": "Date", "value": "1"}, "id": "a"}}),
        ] {
            cursors.push(format!("{CURSOR_PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())));
        }
        for cursor in cursors {
            assert_eq!(page(rows(), &view, 1, Some(&cursor)).err().unwrap().to_string(), RELOAD_REQUIRED);
        }
    }

    #[test]
    fn empty_exact_and_invalid_inputs_have_explicit_boundaries() {
        let view = view("date");
        let empty = page(Vec::<Candidate<()>>::new(), &view, 1, None).unwrap();
        assert!(empty.items.is_empty() && empty.next_cursor.is_none());
        assert!(page(rows(), &view, 6, None).unwrap().next_cursor.is_none());
        assert!(page(rows(), &view, 0, None).is_err());
        assert!(page(vec![row("", 1, "", "")], &view, 1, None).is_err());
        assert!(page(vec![row("a", 1, "", ""), row("a", 2, "x", "y")], &view, 1, None).is_err());
        let mut invalid = View { namespace: "recent".into(), scopes: view.scopes.clone(),
            query: String::new(), filter: String::new(), sort: Sort::default() };
        invalid.namespace.clear();
        assert!(page(rows(), &invalid, 1, None).is_err());
        invalid.namespace = "recent".into();
        invalid.scopes[0].account.clear();
        assert!(page(rows(), &invalid, 1, None).is_err());
        invalid.scopes[0].account = "a".into();
        invalid.scopes[0].folder.clear();
        assert!(page(rows(), &invalid, 1, None).is_err());
    }

    #[test]
    fn duplicate_input_is_rejected_even_before_the_cursor_boundary() {
        let view = view("date:asc");
        let cursor = page(rows(), &view, 2, None).unwrap().next_cursor.unwrap();
        let input = vec![row("duplicate", i64::MIN, "", ""), row("duplicate", i64::MIN, "", "")];
        assert!(page(input, &view, 2, Some(&cursor)).is_err());
    }

    #[test]
    fn a_large_candidate_set_is_not_cut_off_at_message_page_size() {
        let view = view("subject:asc");
        let make_rows = || (0..10_003).rev().map(|index| {
            row(&format!("a#INBOX#{index:05}"), index, "same", "same")
        }).collect();
        let mut cursor = None;
        let mut actual = Vec::new();
        for attempt in 0..=100 {
            let result = page(make_rows(), &view, 137, cursor.as_deref()).unwrap();
            actual.extend(result.items);
            cursor = result.next_cursor;
            if cursor.is_none() { break; }
            assert!(attempt < 100);
        }
        let expected: Vec<_> = (0..10_003).map(|index| format!("a#INBOX#{index:05}")).collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn cursor_survives_boundary_deletion_and_documents_live_insertions() {
        let view = view("date:asc");
        let initial = vec![row("a", 10, "", ""), row("b", 20, "", ""), row("c", 30, "", "")];
        let cursor = page(initial, &view, 2, None).unwrap().next_cursor.unwrap();
        // b was deleted; the new item before the cursor needs a refresh,
        // whereas the new item after it is reachable on this traversal.
        let updated = vec![row("a", 10, "", ""), row("early", 15, "", ""),
            row("late", 25, "", ""), row("c", 30, "", "")];
        assert_eq!(page(updated, &view, 10, Some(&cursor)).unwrap().items, ["late", "c"]);
        // A previously shown conversation that moves across the cursor can
        // reappear: adapters must not promise snapshot semantics.
        let moved = vec![row("a", 40, "", ""), row("c", 30, "", "")];
        assert_eq!(page(moved, &view, 10, Some(&cursor)).unwrap().items, ["c", "a"]);
    }
}
