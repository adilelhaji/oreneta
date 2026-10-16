//! Protocol-neutral mail session boundary.
//!
//! The engine's session pool and `with_*_session` combinators operate on this
//! enum rather than on `imap::Session` directly, so an account's protocol is
//! decided once at connect time and every operation dispatches through here —
//! IMAP today, EWS next. An enum (not a trait object) because the operations
//! are async and return protocol-shared types; matching keeps them statically
//! dispatched without an `async_trait` dependency.
//!
//! IMAP IDLE watchers and the `account.connect` validation path build their
//! own dedicated `imap::connect` connections and are not routed through this
//! type: IDLE is an IMAP-specific long-lived protocol state, not a pooled
//! request session.

use anyhow::Result;
use std::collections::HashSet;

use crate::imap;
use crate::parse;

pub enum Session {
    Imap(imap::Session),
    Ews(crate::exchange::EwsSession),
    Graph(crate::graph::mail::Session),
    /// The local archive (ADR-0014): this database is its server.
    Local(crate::archive::LocalSession),
}

/// Establish a fresh authenticated session for `creds`. An account's protocol
/// is decided here, once per pool refill, by whether it carries an EWS
/// endpoint.
///
/// `db` is handed to the Exchange backend, which needs the store on its own
/// operations to map opaque item ids onto the uids the rest of the core
/// addresses messages by; the IMAP backend ignores it.
pub async fn connect(
    creds: &imap::Creds,
    account: &str,
    db: std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
) -> Result<Session> {
    if creds.is_graph() { return crate::graph::mail::unsupported(); }
    if creds.is_ews() {
        return Ok(Session::Ews(crate::exchange::EwsSession::new(
            crate::exchange::EwsConfig {
                url: creds.ews_url.clone(),
                username: creds.user.clone(),
                password: creds.password.clone(),
                target_mailbox: creds.target_mailbox.clone(),
                proxy: creds.proxy.clone(),
            },
            account,
            db,
        )));
    }
    Ok(Session::Imap(imap::connect(creds).await?))
}

/// Reports an operation the Exchange backend does not implement yet.
///
/// Returning an error rather than a silent no-op is deliberate: a write that
/// quietly did nothing would let the UI show a flag or a move that never
/// reached the server.
fn ews_unsupported<T>(operation: &str) -> Result<T> {
    Err(anyhow::anyhow!(
        "{operation} is not supported on Exchange accounts yet"
    ))
}

// Each method dispatches the like-named `imap::` operation; signatures are
// identical minus the session parameter. Protocol-shared types (`Folder`,
// `MessageHeader`, …) stay in `imap` until the EWS variant forces a move.
impl Session {
    pub async fn list_folders(&mut self) -> Result<Vec<imap::Folder>> {
        match self {
            Session::Local(session) => session.list_folders(),
            Session::Graph(session) => session.list_folders(),
            Session::Imap(session) => imap::list_folders(session).await,
            Session::Ews(session) => session.list_folders().await,
        }
    }

    pub async fn create_folder(&mut self, name: &str) -> Result<()> {
        match self {
            Session::Local(session) => session.create_folder(name),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::create_folder(session, name).await,
            Session::Ews(_) => ews_unsupported("create_folder"),
        }
    }

    pub async fn prepare_folder_delete(&mut self) -> Result<()> {
        match self {
            Session::Local(_) => Ok(()),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::prepare_folder_delete(session).await,
            Session::Ews(_) => ews_unsupported("prepare_folder_delete"),
        }
    }

    pub async fn delete_folders(&mut self, names: &[String]) -> Result<Vec<String>> {
        match self {
            Session::Local(session) => session.delete_folders(names),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::delete_folders(session, names).await,
            Session::Ews(_) => ews_unsupported("delete_folders"),
        }
    }

    /// Rename `from` to `to` (ADR-0050). IMAP's RENAME carries the inferiors
    /// with it; the local store has no server, so it is handed the whole
    /// subtree in `renames` (the source first) and renames each row itself.
    pub async fn rename_folder(&mut self, from: &str, to: &str, renames: &[(String, String)]) -> Result<()> {
        match self {
            Session::Local(session) => session.rename_folders(renames),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::rename_folder(session, from, to).await,
            Session::Ews(_) => ews_unsupported("rename_folder"),
        }
    }

    pub async fn fetch_recent(&mut self, folder: &str, limit: u32) -> Result<imap::RecentBatch> {
        match self {
            Session::Local(session) => session.fetch_recent(folder, limit),
            Session::Graph(session) => session.cached_recent(folder, limit),
            Session::Imap(session) => imap::fetch_recent(session, folder, limit).await,
            Session::Ews(session) => session.fetch_recent(folder, limit).await,
        }
    }

    /// Folder identity plus the newest uids, without their envelopes — the
    /// first half of a sync that fetches headers in isolated chunks so one
    /// unreadable message cannot sink the batch.
    pub async fn recent_uids(&mut self, folder: &str, limit: u32) -> Result<(u32, u32, Vec<u32>)> {
        match self {
            Session::Local(session) => { let b = session.fetch_recent(folder, limit)?; Ok((b.uidvalidity, b.uid_next, b.messages.into_iter().map(|m| m.uid).collect())) },
            Session::Graph(session) => { let b=session.cached_recent(folder,limit)?; Ok((b.uidvalidity,b.uid_next,b.messages.into_iter().map(|m|m.uid).collect())) },
            Session::Imap(session) => imap::recent_uids(session, folder, limit).await,
            Session::Ews(session) => {
                // Exchange has no UIDVALIDITY, and the mapping already knows
                // which uids a folder holds; the batch this pairs with fetches
                // envelopes by uid all the same.
                let batch = session.fetch_recent(folder, limit).await?;
                let uids = batch.messages.iter().map(|m| m.uid).collect();
                Ok((batch.uidvalidity, batch.uid_next, uids))
            }
        }
    }

    pub async fn search_uids(&mut self, folder: &str, query: &str) -> Result<Vec<u32>> {
        match self {
            Session::Local(_) => crate::archive::unsupported("search the server"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::search_uids(session, folder, query).await,
            Session::Ews(_) => ews_unsupported("search_uids"),
        }
    }

    /// Messages sent before `before`, when the server can be asked (IMAP).
    /// `None` means it cannot, and the caller works from the synced copy.
    pub async fn search_sent_before(&mut self, folder: &str, before: i64) -> Result<Option<Vec<u32>>> {
        match self {
            Session::Imap(session) => imap::search_sent_before(session, folder, before).await.map(Some),
            _ => Ok(None),
        }
    }

    pub async fn list_all_uids(&mut self, folder: &str) -> Result<HashSet<u32>> {
        match self {
            Session::Local(session) => session.list_all_uids(folder),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::list_all_uids(session, folder).await,
            Session::Ews(_) => ews_unsupported("list_all_uids"),
        }
    }

    pub async fn search_starred_uids(&mut self, folder: &str, limit: u32) -> Result<Vec<u32>> {
        match self {
            Session::Local(_) => Ok(Vec::new()),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::search_starred_uids(session, folder, limit).await,
            Session::Ews(_) => ews_unsupported("search_starred_uids"),
        }
    }

    pub async fn fetch_by_message_ids(
        &mut self,
        folder: &str,
        ids: &[String],
        media_root: &std::path::Path,
        account: &str,
    ) -> Result<Vec<imap::FetchedMessage>> {
        match self {
            Session::Local(_) => Ok(Vec::new()),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => {
                imap::fetch_by_message_ids(session, folder, ids, media_root, account).await
            }
            Session::Ews(_) => ews_unsupported("fetch_by_message_ids"),
        }
    }

    pub async fn fetch_headers_by_uid(
        &mut self,
        folder: &str,
        uids: &[u32],
    ) -> Result<Vec<imap::MessageHeader>> {
        match self {
            Session::Local(session) => { let wanted: HashSet<u32> = uids.iter().copied().collect(); Ok(session.fetch_recent(folder, u32::MAX)?.messages.into_iter().filter(|m| wanted.contains(&m.uid)).collect()) },
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::fetch_headers_by_uid(session, folder, uids).await,
            Session::Ews(_) => ews_unsupported("fetch_headers_by_uid"),
        }
    }

    /// Which of these messages carry an attachment, as the server sees it.
    ///
    /// Exchange answers nothing here rather than answering "none": the sync
    /// path does not ask it for that property yet, and reporting no
    /// attachments for a mailbox that has them would be worse than saying
    /// nothing and leaving them unknown.
    pub async fn attachment_flags(
        &mut self,
        folder: &str,
        uids: &[u32],
    ) -> Result<Vec<(u32, bool)>> {
        match self {
            Session::Local(_) => Ok(Vec::new()),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::fetch_attachment_flags(session, folder, uids).await,
            Session::Ews(_) => Ok(Vec::new()),
        }
    }

    pub async fn sync_flags(
        &mut self,
        folder: &str,
        since_modseq: u64,
        validity_matches: bool,
    ) -> Result<imap::FlagSync> {
        match self {
            Session::Local(_) => Ok(imap::FlagSync::default()),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => {
                imap::sync_flags(session, folder, since_modseq, validity_matches).await
            }
            Session::Ews(_) => ews_unsupported("sync_flags"),
        }
    }

    pub async fn read_message(
        &mut self,
        folder: &str,
        uid: u32,
        media: &parse::MediaCtx,
    ) -> Result<parse::Message> {
        match self {
            Session::Local(session) => session.read_message(folder, uid, media),
            Session::Graph(session) => session.read_message(folder, uid, Some(media.clone())).await,
            Session::Imap(session) => imap::read_message(session, folder, uid, media).await,
            Session::Ews(session) => session.read_message(folder, uid, media).await,
        }
    }

    pub async fn prepare_flag_update(&mut self, folder: &str) -> Result<()> {
        match self {
            Session::Local(session) => { session.select(folder); Ok(()) },
            // Nothing to select: each Graph change names its message.
            Session::Graph(_) => Ok(()),
            Session::Imap(session) => imap::prepare_flag_update(session, folder).await,
            Session::Ews(session) => {
                session.prepare_flag_update(folder);
                Ok(())
            }
        }
    }

    /// The account's calendars, or an empty list for a backend without any.
    ///
    /// IMAP carries no calendars at all, so an account on it reports none
    /// rather than failing: a client asking every account what it has should
    /// not have to know which protocols answer.
    pub async fn list_calendars(&mut self) -> Result<Vec<crate::calendar::Calendar>> {
        match self {
            Session::Local(_) => Ok(Vec::new()),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Ok(Vec::new()),
            Session::Ews(session) => session.list_calendars().await,
        }
    }

    /// The occurrences on a calendar between two instants.
    pub async fn events_in_window(
        &mut self,
        calendar_id: &str,
        from: i64,
        to: i64,
    ) -> Result<Vec<crate::calendar::Event>> {
        match self {
            Session::Local(_) => crate::archive::unsupported("events_in_window"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Ok(Vec::new()),
            Session::Ews(session) => session.events_in_window(calendar_id, from, to).await,
        }
    }

    pub async fn create_calendar(&mut self, name: &str) -> Result<String> {
        match self {
            Session::Local(_) => crate::archive::unsupported("create_calendar"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Err(anyhow::anyhow!("this account has no calendar")),
            Session::Ews(session) => session.create_calendar(name).await,
        }
    }

    pub async fn rename_calendar(&mut self, calendar_id: &str, name: &str) -> Result<()> {
        match self {
            Session::Local(_) => crate::archive::unsupported("rename_calendar"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Err(anyhow::anyhow!("this account has no calendar")),
            Session::Ews(session) => session.rename_calendar(calendar_id, name).await,
        }
    }

    pub async fn delete_calendar(&mut self, calendar_id: &str) -> Result<()> {
        match self {
            Session::Local(_) => crate::archive::unsupported("delete_calendar"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Err(anyhow::anyhow!("this account has no calendar")),
            Session::Ews(session) => session.delete_calendar(calendar_id).await,
        }
    }

    /// Creates an event, returning it with the id the server assigned.
    pub async fn create_event(
        &mut self,
        event: &crate::calendar::Event,
        notify: bool,
    ) -> Result<crate::calendar::Event> {
        match self {
            Session::Local(_) => crate::archive::unsupported("create_event"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Err(anyhow::anyhow!("this account has no calendar")),
            Session::Ews(session) => session.create_event(event, notify).await,
        }
    }

    /// Answers a meeting invitation.
    pub async fn respond(
        &mut self,
        event_id: &str,
        change_key: Option<&str>,
        response: crate::calendar::Response,
    ) -> Result<()> {
        match self {
            Session::Local(_) => crate::archive::unsupported("respond"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Err(anyhow::anyhow!("this account has no calendar")),
            Session::Ews(session) => session.respond(event_id, change_key, response).await,
        }
    }

    /// Directory entries matching a name or partial address. An account with
    /// no directory behind it answers with nothing rather than an error: there
    /// is nobody to find, which is not a failure.
    pub async fn resolve_names(
        &mut self,
        query: &str,
    ) -> Result<Vec<crate::calendar::Participant>> {
        match self {
            Session::Local(_) => crate::archive::unsupported("resolve_names"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Ok(Vec::new()),
            Session::Ews(session) => session.resolve_names(query).await,
        }
    }

    /// The attendees and notes of one event, which a window cannot carry.
    pub async fn event_details(
        &mut self,
        event_id: &str,
        change_key: Option<&str>,
    ) -> Result<(Vec<crate::calendar::Participant>, String)> {
        match self {
            Session::Local(_) => crate::archive::unsupported("event_details"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Ok((Vec::new(), String::new())),
            Session::Ews(session) => session.event_details(event_id, change_key).await,
        }
    }

    /// The rule behind the series an occurrence belongs to.
    pub async fn series_rule(
        &mut self,
        event_id: &str,
        change_key: Option<&str>,
    ) -> Result<Option<crate::calendar::Recurrence>> {
        match self {
            Session::Local(_) => crate::archive::unsupported("series_rule"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Ok(None),
            Session::Ews(session) => session.series_rule(event_id, change_key).await,
        }
    }

    pub async fn update_event(
        &mut self,
        event: &crate::calendar::Event,
        whole_series: bool,
        notify: bool,
    ) -> Result<()> {
        match self {
            Session::Local(_) => crate::archive::unsupported("update_event"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Err(anyhow::anyhow!("this account has no calendar")),
            Session::Ews(session) => session.update_event(event, whole_series, notify).await,
        }
    }

    pub async fn delete_event(
        &mut self,
        id: &str,
        change_key: Option<&str>,
        whole_series: bool,
        notify: bool,
    ) -> Result<()> {
        match self {
            Session::Local(_) => crate::archive::unsupported("delete_event"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(_) => Err(anyhow::anyhow!("this account has no calendar")),
            Session::Ews(session) => session.delete_event(id, change_key, whole_series, notify).await,
        }
    }

    /// Transmits a message. Only the Exchange backend implements this: IMAP
    /// accounts submit through SMTP, which is not a session operation.
    pub async fn send_mime(&mut self, raw: Vec<u8>) -> Result<()> {
        match self {
            Session::Local(_) => crate::archive::unsupported("send mail"),
            Session::Graph(session) => session.send_mime(raw).await,
            Session::Imap(_) => Err(anyhow::anyhow!(
                "IMAP accounts send through SMTP, not the mail session"
            )),
            Session::Ews(session) => session.send_mime(raw).await,
        }
    }

    /// Transmits a message whose sender may have asked for a delivery
    /// receipt (#210, ADR-0057), answering what became of the request and,
    /// when it went without one on Graph, why. Microsoft Graph carries it
    /// where `graph::mail::delivery_receipt` says so; the other sessions
    /// carry none and send as [`Self::send_mime`] does.
    pub async fn send_mime_with_receipt(
        &mut self,
        raw: Vec<u8>,
        asked: bool,
        bcc: bool,
        protected: bool,
    ) -> Result<(crate::smtp::DeliveryReceipt, Option<&'static str>)> {
        match self {
            Session::Graph(session) => {
                let (receipt, withheld) = session.send_mime_with_receipt(raw, asked, bcc, protected).await?;
                Ok((receipt, withheld.map(crate::graph::mail::Withheld::as_str)))
            }
            _ => {
                self.send_mime(raw).await?;
                Ok((crate::receipts::delivery_receipt(asked, false), None))
            }
        }
    }

    pub async fn store_seen(&mut self, uids: &[u32], seen: bool) -> Result<()> {
        match self {
            Session::Local(_) => Ok(()),
            Session::Graph(session) => session.set_seen(uids, seen).await,
            Session::Imap(session) => imap::store_seen(session, uids, seen).await,
            Session::Ews(session) => session.store_seen(uids, seen).await,
        }
    }

    pub async fn store_starred(&mut self, uids: &[u32], starred: bool) -> Result<()> {
        match self {
            Session::Local(_) => Ok(()),
            Session::Graph(session) => session.set_flagged(uids, starred).await,
            Session::Imap(session) => imap::store_starred(session, uids, starred).await,
            Session::Ews(_) => ews_unsupported("store_starred"),
        }
    }

    /// The write half of a linked label — see
    /// docs/adr/0002-remote-label-linking.md. A no-op on any account that
    /// isn't Gmail, including Exchange: nothing here to write to.
    pub async fn store_gmail_label(&mut self, uids: &[u32], label: &str, present: bool) -> Result<()> {
        match self {
            Session::Local(_) => Ok(()),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::store_gmail_label(session, uids, label, present).await,
            Session::Ews(_) => Ok(()),
        }
    }

    pub async fn move_to_folder(
        &mut self,
        source_folder: &str,
        dest_folder: &str,
        uids: &[u32],
    ) -> Result<()> {
        match self {
            Session::Local(session) => session.move_to_folder(source_folder, dest_folder, uids),
            Session::Graph(session) => session.move_uids(source_folder, dest_folder, uids).await,
            Session::Imap(session) => {
                imap::move_to_folder(session, source_folder, dest_folder, uids).await
            }
            Session::Ews(session) => {
                session.move_to_folder(source_folder, dest_folder, uids).await
            }
        }
    }

    pub async fn fetch_raw_messages_for_copy(
        &mut self,
        folder: &str,
        uids: &[u32],
    ) -> Result<Vec<imap::RawMessageCopy>> {
        match self {
            Session::Local(session) => session.raw_for_copy(folder, uids),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => {
                imap::fetch_raw_messages_for_copy(session, folder, uids).await
            }
            Session::Ews(_) => ews_unsupported("fetch_raw_messages_for_copy"),
        }
    }

    pub async fn append_copied_message(
        &mut self,
        folder: &str,
        message: &imap::RawMessageCopy,
    ) -> Result<()> {
        match self {
            Session::Local(session) => session.append(folder, message),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::append_copied_message(session, folder, message).await,
            Session::Ews(_) => ews_unsupported("append_copied_message"),
        }
    }

    pub async fn expunge_uids(&mut self, folder: &str, uids: &[u32]) -> Result<()> {
        match self {
            Session::Local(session) => session.expunge(folder, uids),
            // Reached only from Deleted Items or Drafts (delete_to_trash).
            Session::Graph(session) => session.delete_uids(folder, uids).await,
            Session::Imap(session) => imap::expunge_uids(session, folder, uids).await,
            Session::Ews(session) => session.expunge_uids(folder, uids).await,
        }
    }

    /// Copy within one account on the server, where the protocol can (Graph).
    /// `None` means use the raw fetch-and-append path instead.
    pub async fn copy_within(
        &mut self,
        source_folder: &str,
        dest_folder: &str,
        uids: &[u32],
    ) -> Result<Option<usize>> {
        match self {
            Session::Local(session) => session.copy_within(source_folder, dest_folder, uids).map(Some),
            Session::Graph(session) => session.copy_uids(source_folder, dest_folder, uids).await.map(Some),
            _ => Ok(None),
        }
    }

    pub async fn empty_folder(&mut self, folder: &str) -> Result<u32> {
        match self {
            Session::Local(session) => session.empty_folder(folder),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::empty_folder(session, folder).await,
            Session::Ews(_) => ews_unsupported("empty_folder"),
        }
    }

    pub async fn append_to_sent(&mut self, folder: &str, raw: &[u8]) -> Result<()> {
        match self {
            Session::Local(_) => crate::archive::unsupported("append_to_sent"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::append_to_sent(session, folder, raw).await,
            Session::Ews(_) => ews_unsupported("append_to_sent"),
        }
    }

    pub async fn replace_draft(
        &mut self,
        folder: &str,
        raw: &[u8],
        message_id: &str,
    ) -> Result<()> {
        match self {
            Session::Local(_) => crate::archive::unsupported("replace_draft"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::replace_draft(session, folder, raw, message_id).await,
            Session::Ews(_) => ews_unsupported("replace_draft"),
        }
    }

    pub async fn discard_draft(&mut self, folder: &str, message_id: &str) -> Result<usize> {
        match self {
            Session::Local(_) => crate::archive::unsupported("discard_draft"),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::discard_draft(session, folder, message_id).await,
            Session::Ews(_) => ews_unsupported("discard_draft"),
        }
    }

    /// The folder holding a special-use role, preferring what the server
    /// declares and falling back to the name heuristics.
    ///
    /// Derived from the folder listing rather than implemented per backend:
    /// both report the role a server assigns (IMAP through its LIST
    /// attributes, Exchange through its distinguished folder ids), and the
    /// name fallback is shared.
    async fn find_role_folder(
        &mut self,
        role: &str,
        looks_like: fn(&str) -> bool,
    ) -> Result<Option<String>> {
        // Exchange answers this from the store when it can: listing its
        // hierarchy is two round trips, and the pool would pay them on every
        // session. IMAP's LIST is a single cheap command, so it keeps asking.
        if let Session::Ews(session) = self {
            return session.role_folder(role).await;
        }
        let folders = self.list_folders().await?;
        let by_role = folders
            .iter()
            .find(|folder| folder.special_use.as_deref() == Some(role))
            .map(|folder| folder.name.clone());
        let by_name = folders
            .iter()
            .find(|folder| looks_like(&folder.name))
            .map(|folder| folder.name.clone());
        Ok(by_role.or(by_name))
    }

    pub async fn find_sent_folder(&mut self) -> Result<Option<String>> {
        self.find_role_folder("sent", imap::looks_like_sent).await
    }

    pub async fn find_trash_folder(&mut self) -> Result<Option<String>> {
        self.find_role_folder("trash", imap::looks_like_trash).await
    }

    pub async fn find_archive_folder(&mut self) -> Result<Option<String>> {
        self.find_role_folder("archive", imap::looks_like_archive)
            .await
    }

    pub async fn find_drafts_folder(&mut self) -> Result<Option<String>> {
        self.find_role_folder("drafts", imap::looks_like_drafts)
            .await
    }

    pub async fn fetch_full_message(
        &mut self,
        uid: u32,
        media: &parse::MediaCtx,
        peek: bool,
    ) -> Result<Option<parse::Message>> {
        match self {
            Session::Local(session) => session.fetch_full_message(uid, media),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::fetch_full_message(session, uid, media, peek).await,
            Session::Ews(_) => ews_unsupported("fetch_full_message"),
        }
    }

    pub async fn fetch_bodies(
        &mut self,
        folder: &str,
        uids: &[u32],
        media_root: std::path::PathBuf,
        account: &str,
    ) -> Result<Vec<(u32, parse::Message)>> {
        match self {
            Session::Local(session) => session.fetch_bodies(folder, uids, &media_root),
            Session::Graph(session) => session.fetch_bodies(folder, uids, media_root).await,
            Session::Imap(session) => {
                imap::fetch_bodies(session, folder, uids, media_root, account).await
            }
            Session::Ews(session) => {
                session.fetch_bodies(folder, uids, media_root, account).await
            }
        }
    }

    pub async fn search_prefetch_uids(&mut self, folder: &str, days: u32) -> Result<Vec<u32>> {
        match self {
            Session::Local(_) => Ok(Vec::new()),
            Session::Graph(_) => crate::graph::mail::unsupported(),
            Session::Imap(session) => imap::search_prefetch_uids(session, folder, days).await,
            Session::Ews(session) => session.search_prefetch_uids(folder, days),
        }
    }
}
