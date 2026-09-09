//! Additive Graph cache projection. See docs/graph-mail-integration.md.
use super::*;
use anyhow::Context;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

pub(crate) const SCHEMA: &str = "
CREATE TABLE graph_profiles (
 account TEXT PRIMARY KEY, tenant TEXT NOT NULL, object TEXT NOT NULL,
 generation TEXT NOT NULL, state TEXT NOT NULL, display_name TEXT NOT NULL,
 tree_ready INTEGER NOT NULL DEFAULT 0,
 error TEXT, retry_after INTEGER, pages INTEGER NOT NULL DEFAULT 0,
 changes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE graph_folders (
 account TEXT NOT NULL, remote_id TEXT NOT NULL, local_name TEXT NOT NULL,
 display_name TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL,
 search_folder INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(account,remote_id)
);
CREATE UNIQUE INDEX graph_folder_active_name ON graph_folders(account,local_name) WHERE active=1;
CREATE TABLE graph_items (
 account TEXT NOT NULL, remote_id TEXT NOT NULL, uid INTEGER NOT NULL,
 fields TEXT NOT NULL, PRIMARY KEY(account,remote_id), UNIQUE(account,uid)
);
CREATE TABLE graph_memberships (
 account TEXT NOT NULL, folder_id TEXT NOT NULL, remote_id TEXT NOT NULL,
 PRIMARY KEY(account,folder_id,remote_id)
);
CREATE INDEX graph_membership_item ON graph_memberships(account,remote_id,folder_id);
CREATE TABLE graph_delta (
 account TEXT NOT NULL, folder_id TEXT NOT NULL, checkpoint TEXT NOT NULL,
 PRIMARY KEY(account,folder_id)
);
CREATE TABLE graph_rounds (
 account TEXT NOT NULL, folder_id TEXT NOT NULL, next_checkpoint TEXT NOT NULL,
 full INTEGER NOT NULL, PRIMARY KEY(account,folder_id)
);
CREATE TABLE graph_staged_items (
 account TEXT NOT NULL, folder_id TEXT NOT NULL, remote_id TEXT NOT NULL,
 fields TEXT NOT NULL, removed INTEGER NOT NULL,
 PRIMARY KEY(account,folder_id,remote_id)
);
CREATE TABLE graph_round_links (
 account TEXT NOT NULL, folder_id TEXT NOT NULL, link TEXT NOT NULL,
 PRIMARY KEY(account,folder_id,link)
);
";

pub type Db = Arc<Mutex<Connection>>;

/// Transport seam for deterministic provider fixtures. Production supplies a
/// fresh independently refreshed Graph grant for each bounded request.
pub trait Source: Send + Sync {
    fn folders(
        &self,
        parent: Option<&ResourceId>,
        checkpoint: Option<&Checkpoint>,
    ) -> Result<Page<Folder>>;
    fn well_known(&self, alias: &str) -> Result<Folder>;
    fn delta(&self, folder: &ResourceId, checkpoint: Option<&Checkpoint>) -> Result<Page<Message>>;
    fn message(&self, id: &ResourceId) -> Result<Message>;
}
impl Source for Client {
    fn folders(&self, p: Option<&ResourceId>, c: Option<&Checkpoint>) -> Result<Page<Folder>> {
        self.folders(p, c)
    }
    fn well_known(&self, a: &str) -> Result<Folder> {
        self.well_known_folder(a)
    }
    fn delta(&self, f: &ResourceId, c: Option<&Checkpoint>) -> Result<Page<Message>> {
        self.message_delta(f, c)
    }
    fn message(&self, id: &ResourceId) -> Result<Message> {
        self.message(id)
    }
}
pub struct NativeSource {
    pub account: String,
    pub auth: Arc<auth::NativeManager>,
    pub proxy: crate::proxy::ProxyChoice,
}
impl NativeSource {
    fn client(&self) -> Result<Client> {
        let record = self
            .auth
            .record(&self.account, &self.proxy)
            .map_err(auth_error)?;
        Ok(Client::new(
            record.grant().map_err(auth_error)?,
            self.proxy.clone(),
        ))
    }
}
impl Source for NativeSource {
    fn folders(&self, p: Option<&ResourceId>, c: Option<&Checkpoint>) -> Result<Page<Folder>> {
        self.client()?.folders(p, c)
    }
    fn well_known(&self, a: &str) -> Result<Folder> {
        self.client()?.well_known_folder(a)
    }
    fn delta(&self, f: &ResourceId, c: Option<&Checkpoint>) -> Result<Page<Message>> {
        self.client()?.message_delta(f, c)
    }
    fn message(&self, id: &ResourceId) -> Result<Message> {
        self.client()?.message(id)
    }
}
fn auth_error(error: auth::Failure) -> Error {
    Error::new(match error {
        auth::Failure::Storage => ErrorKind::Storage,
        auth::Failure::Denied => ErrorKind::AccessDenied,
        auth::Failure::ConsentRequired => ErrorKind::ConsentRequired,
        auth::Failure::Unavailable => ErrorKind::Unavailable,
        _ => ErrorKind::Reauthenticate,
    })
}
fn clean_error(error: anyhow::Error) -> Error {
    error
        .downcast_ref::<Error>()
        .cloned()
        .unwrap_or_else(|| Error::new(ErrorKind::Storage))
}
fn invalid<T>() -> Result<T> {
    Err(Error::new(ErrorKind::InvalidResponse))
}

#[derive(Clone, Serialize)]
pub struct Lease {
    pub account: String,
    pub generation: String,
}
#[derive(Serialize)]
pub struct Status {
    pub account: String,
    pub state: String,
    pub pages: u64,
    pub changes: u64,
    pub error: Option<String>,
    pub retry_after_seconds: Option<u64>,
    pub mail_backend_ready: bool,
}

pub fn status(conn: &Connection, account: &str) -> Result<Status> {
    (||->anyhow::Result<Status>{
        let mut s=conn.query_row("SELECT state,pages,changes,error,retry_after FROM graph_profiles WHERE account=?1",[account],|r|Ok(Status{
            account:account.into(),state:r.get(0)?,pages:r.get::<_,i64>(1)?.max(0) as u64,changes:r.get::<_,i64>(2)?.max(0) as u64,error:r.get(3)?,retry_after_seconds:r.get::<_,Option<i64>>(4)?.map(|v|v.max(0) as u64),mail_backend_ready:false
        }))?;
        s.mail_backend_ready=conn.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1 AND json_extract(config,'$.auth_type')='graph_oauth')",[account],|r|r.get(0))?;
        Ok(s)
    })().map_err(clean_error)
}

/// Capture only non-secret metadata; never convert an existing mail profile.
pub fn begin_profile(
    conn: &Connection,
    account: &str,
    principal: &auth::Principal,
    name: &str,
) -> Result<Lease> {
    (||->anyhow::Result<Lease>{
        let tx=conn.unchecked_transaction()?;
        let existing:Option<String>=tx.query_row("SELECT COALESCE(json_extract(config,'$.auth_type'),'') FROM accounts WHERE id=?1",[account],|r|r.get(0)).optional()?;
        if existing.as_deref().is_some_and(|kind|kind!="graph_oauth") { return Err(Error::new(ErrorKind::AccountConflict).into()); }
        let previous:Option<(String,String)>=tx.query_row("SELECT tenant,object FROM graph_profiles WHERE account=?1",[account],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if previous.is_some_and(|p|p!=(principal.tenant.clone(),principal.object.clone())) { return Err(Error::new(ErrorKind::AccountConflict).into()); }
        let generation=uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO graph_profiles(account,tenant,object,generation,state,display_name) VALUES(?1,?2,?3,?4,'syncing',?5)
            ON CONFLICT(account) DO UPDATE SET generation=excluded.generation,state='syncing',tree_ready=0,error=NULL,retry_after=NULL,display_name=excluded.display_name",
            params![account,principal.tenant,principal.object,generation,name])?;
        tx.commit()?;
        Ok(Lease{account:account.into(),generation})
    })().map_err(clean_error)
}
fn check(conn: &Connection, lease: &Lease) -> anyhow::Result<()> {
    let valid:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM graph_profiles WHERE account=?1 AND generation=?2 AND state!='cancelled')",params![lease.account,lease.generation],|r|r.get(0))?;
    if !valid {
        return Err(Error::new(ErrorKind::Cancelled).into());
    }
    Ok(())
}
pub fn cancel(conn: &Connection, lease: &Lease) -> Result<()> {
    conn.execute("UPDATE graph_profiles SET state=CASE WHEN EXISTS(SELECT 1 FROM accounts WHERE id=?1 AND json_extract(config,'$.auth_type')='graph_oauth') THEN 'ready' ELSE 'cancelled' END,generation=?3 WHERE account=?1 AND generation=?2",params![lease.account,lease.generation,uuid::Uuid::new_v4().to_string()]).map_err(|_|Error::new(ErrorKind::Storage))?;
    Ok(())
}
pub fn record_failure(conn: &Connection, lease: &Lease, error: &Error) -> Result<()> {
    let kind = serde_json::to_value(error.kind)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    conn.execute("UPDATE graph_profiles SET state='failed',error=?3,retry_after=?4 WHERE account=?1 AND generation=?2",params![lease.account,lease.generation,kind,error.retry_after_seconds.map(|v|v.min(i64::MAX as u64) as i64)]).map_err(|_|Error::new(ErrorKind::Storage))?;
    Ok(())
}

fn checked_id(id: &ResourceId, account: &str, kind: ResourceKind) -> Result<()> {
    if id.account() != account || id.kind() != kind {
        return invalid();
    }
    Ok(())
}
fn local_folder(id: &str, role: &str) -> String {
    if role == "inbox" {
        "INBOX".into()
    } else {
        format!("graph.{}", B64.encode(id))
    }
}
const ROLES: [(&str, &str); 6] = [
    ("inbox", "inbox"),
    ("sentitems", "sent"),
    ("drafts", "drafts"),
    ("deleteditems", "trash"),
    ("junkemail", "junk"),
    ("archive", "archive"),
];

pub fn sync_tree(source: &dyn Source, db: &Db, lease: &Lease) -> Result<()> {
    (||->anyhow::Result<()>{
        check(&db.lock().unwrap(),lease)?;
        let root=source.well_known("msgfolderroot")?;
        checked_id(&root.id,&lease.account,ResourceKind::Folder)?;
        let mut roles=HashMap::new();
        for (alias,role) in ROLES {
            check(&db.lock().unwrap(),lease)?;
            match source.well_known(alias) {
                Ok(folder)=> { checked_id(&folder.id,&lease.account,ResourceKind::Folder)?; roles.insert(folder.id.opaque().to_owned(),role); }
                Err(e) if e.kind==ErrorKind::NotFound && alias!="inbox"=>{},
                Err(e)=>return Err(e.into()),
            }
        }
        let mut queue=VecDeque::from([None]);
        let mut folders=Vec::new();
        let mut ids=HashSet::new();
        while let Some(parent)=queue.pop_front() {
            let mut checkpoint=None;
            let mut visited=HashSet::new();
            loop {
                check(&db.lock().unwrap(),lease)?;
                let page=source.folders(parent.as_ref(),checkpoint.as_ref())?;
                for f in page.items {
                    checked_id(&f.id,&lease.account,ResourceKind::Folder)?;
                    let expected_parent=parent.as_ref().unwrap_or(&root.id);
                    if f.id==root.id || !ids.insert(f.id.opaque().to_owned()) || f.fields.parent_folder_id.as_deref()!=Some(expected_parent.opaque()) {
                        return Err(Error::new(ErrorKind::InvalidResponse).into());
                    }
                    if f.fields.child_folder_count>0 { queue.push_back(Some(f.id.clone())); }
                    folders.push(f);
                }
                checkpoint=page.checkpoint;
                if let Some(c)=&checkpoint {
                    if c.kind!=CheckpointKind::NextPage || !visited.insert(c.url.clone()) { return Err(Error::new(ErrorKind::InvalidResponse).into()); }
                } else { break; }
            }
        }
        if !folders.iter().any(|f|roles.get(f.id.opaque())==Some(&"inbox")) { return Err(Error::new(ErrorKind::InvalidResponse).into()); }
        let conn=db.lock().unwrap(); check(&conn,lease)?;
        let tx=conn.unchecked_transaction()?;
        tx.execute("UPDATE graph_folders SET active=0 WHERE account=?1",[&lease.account])?;
        for f in folders {
            let role=roles.get(f.id.opaque()).copied().unwrap_or("folder");
            tx.execute("INSERT INTO graph_folders(account,remote_id,local_name,display_name,parent_id,role,search_folder,active) VALUES(?1,?2,?3,?4,?5,?6,?7,1)
                ON CONFLICT(account,remote_id) DO UPDATE SET display_name=excluded.display_name,parent_id=excluded.parent_id,role=excluded.role,search_folder=excluded.search_folder,active=1",
                params![lease.account,f.id.opaque(),local_folder(f.id.opaque(),role),f.fields.display_name,f.fields.parent_folder_id,role,f.fields.item_type.as_deref()==Some("#microsoft.graph.mailSearchFolder")])?;
        }
        // Only Graph-owned memberships in retired folders may lose cache rows.
        tx.execute("DELETE FROM messages WHERE account=?1 AND EXISTS(SELECT 1 FROM graph_memberships m JOIN graph_items i ON i.account=m.account AND i.remote_id=m.remote_id JOIN graph_folders f ON f.account=m.account AND f.remote_id=m.folder_id WHERE m.account=?1 AND f.active=0 AND messages.folder=f.local_name AND messages.uid=i.uid)", [&lease.account])?;
        for table in ["graph_memberships", "graph_delta", "graph_rounds", "graph_staged_items", "graph_round_links"] {
            tx.execute(&format!("DELETE FROM {table} WHERE account=?1 AND folder_id IN(SELECT remote_id FROM graph_folders WHERE account=?1 AND active=0)"),[&lease.account])?;
        }
        tx.execute("DELETE FROM folders WHERE account=?1 AND name IN(SELECT local_name FROM graph_folders WHERE account=?1 AND active=0) AND name NOT IN(SELECT local_name FROM graph_folders WHERE account=?1 AND active=1)",[&lease.account])?;
        tx.execute("INSERT INTO folders(account,name,delimiter,special_use) SELECT account,local_name,NULL,CASE WHEN role='folder' THEN NULL ELSE role END FROM graph_folders WHERE account=?1 AND active=1
            ON CONFLICT(account,name) DO UPDATE SET special_use=excluded.special_use",[&lease.account])?;
        tx.execute("UPDATE graph_profiles SET tree_ready=1 WHERE account=?1 AND generation=?2",params![lease.account,lease.generation])?;
        tx.commit()?;
        Ok(())
    })().map_err(clean_error)
}

// Checkpoints stay internal and must be revalidated after reading disk. Never
// accept these JSON blobs through a frontend method.
fn pack(c: &Checkpoint) -> String {
    json!({"account":c.account,"collection":c.collection,"url":c.url,"delta":c.kind==CheckpointKind::Delta}).to_string()
}
fn unpack(blob: &str, account: &str, folder: &str) -> Result<Checkpoint> {
    let value: Value =
        serde_json::from_str(blob).map_err(|_| Error::new(ErrorKind::InvalidResponse))?;
    let client = Client::new(
        Grant::new(account, "unused", "Mail.Read", i64::MAX)?,
        crate::proxy::ProxyChoice::Direct,
    );
    let collection = client
        .route(&["me", "mailFolders", folder, "messages", "delta"])
        .path()
        .to_owned();
    if value["account"].as_str() != Some(account)
        || value["collection"].as_str() != Some(&collection)
    {
        return invalid();
    }
    let url = value["url"]
        .as_str()
        .ok_or_else(|| Error::new(ErrorKind::InvalidResponse))?;
    client.validate_link(url, &collection)?;
    Ok(Checkpoint {
        account: account.into(),
        collection,
        url: url.into(),
        kind: if value["delta"]
            .as_bool()
            .ok_or_else(|| Error::new(ErrorKind::InvalidResponse))?
        {
            CheckpointKind::Delta
        } else {
            CheckpointKind::NextPage
        },
    })
}
fn fields_json(fields: &MessageFields) -> Value {
    let mut value = serde_json::to_value(fields).unwrap();
    value.as_object_mut().unwrap().retain(|_, v| !v.is_null());
    value
}
fn merge_fields(previous: Option<&str>, patch: &Value) -> anyhow::Result<Value> {
    let mut value: Value = previous
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or(json!({}));
    let target = value.as_object_mut().context("invalid cached Graph item")?;
    if patch
        .get("@odata.etag")
        .is_some_and(|etag| target.get("@odata.etag") != Some(etag))
    {
        target.remove("body");
    }
    for (k, v) in patch.as_object().context("invalid Graph item")? {
        target.insert(k.clone(), v.clone());
    }
    Ok(value)
}
fn metadata_complete(value: &Value) -> bool {
    [
        "conversationId",
        "subject",
        "receivedDateTime",
        "parentFolderId",
    ]
    .iter()
    .all(|k| value[k].is_string())
        && value["isRead"].is_boolean()
        && value["toRecipients"].is_array()
        && value["ccRecipients"].is_array()
        && value["hasAttachments"].is_boolean()
}
fn recipients(value: &[Recipient]) -> Vec<crate::imap::Recipient> {
    value
        .iter()
        .map(|r| crate::imap::Recipient {
            name: r.email_address.name.clone().unwrap_or_default(),
            addr: r.email_address.address.clone().unwrap_or_default(),
        })
        .collect()
}
fn header(fields: &MessageFields, uid: u32) -> Result<crate::imap::MessageHeader> {
    let conversation = fields
        .conversation_id
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::new(ErrorKind::InvalidResponse))?;
    let date =
        chrono::DateTime::parse_from_rfc3339(fields.received_date_time.as_deref().unwrap_or(""))
            .map_err(|_| Error::new(ErrorKind::InvalidResponse))?
            .timestamp();
    let from = fields
        .from
        .as_ref()
        .map(|r| r.email_address.clone())
        .unwrap_or(EmailAddress {
            name: None,
            address: None,
        });
    let starred = match fields.flag.as_ref().map(|f| f.flag_status.as_str()) {
        Some("flagged") => true,
        Some("notFlagged" | "complete") | None => false,
        _ => return invalid(),
    };
    Ok(crate::imap::MessageHeader {
        uid,
        subject: fields.subject.clone().unwrap_or_default(),
        from_name: from.name.unwrap_or_default(),
        from_addr: from.address.unwrap_or_default(),
        date,
        seen: fields
            .is_read
            .ok_or_else(|| Error::new(ErrorKind::InvalidResponse))?,
        starred,
        thread_key: format!("graph:{}", B64.encode(conversation)),
        message_id: fields
            .internet_message_id
            .clone()
            .unwrap_or_default()
            .trim_matches(['<', '>'])
            .to_owned(),
        has_attachments: fields.has_attachments,
        to: recipients(fields.to_recipients.as_deref().unwrap_or(&[])),
        cc: recipients(fields.cc_recipients.as_deref().unwrap_or(&[])),
        ..Default::default()
    })
}

/// Accept a single page. `false` means staging is durable, NOT a complete sync.
pub fn sync_page(source: &dyn Source, db: &Db, lease: &Lease, folder: &str) -> Result<bool> {
    (||->anyhow::Result<bool>{
        let (remote,search,checkpoint,full)={
            let conn=db.lock().unwrap(); check(&conn,lease)?;
            let (remote,search):(String,bool)=conn.query_row("SELECT remote_id,search_folder FROM graph_folders WHERE account=?1 AND local_name=?2 AND active=1",params![lease.account,folder],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let round:Option<(String,bool)>=conn.query_row("SELECT next_checkpoint,full FROM graph_rounds WHERE account=?1 AND folder_id=?2",params![lease.account,remote],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let (blob,full)=if let Some((next,full))=round{(Some(next),full)}else{
                let active:Option<String>=conn.query_row("SELECT checkpoint FROM graph_delta WHERE account=?1 AND folder_id=?2",params![lease.account,remote],|r|r.get(0)).optional()?;
                let full=active.is_none();(active,full)
            };
            let c=blob.as_deref().map(|b|unpack(b,&lease.account,&remote)).transpose()?;
            (remote,search,c,full)
        };
        let id=ResourceId::new(&lease.account,ResourceKind::Folder,&remote)?;
        let page=match source.delta(&id,checkpoint.as_ref()) {
            Ok(p)=>p,
            Err(e) if e.kind==ErrorKind::ResyncRequired=>{
                let conn=db.lock().unwrap();check(&conn,lease)?;
                let tx=conn.unchecked_transaction()?;clear_round(&tx,&lease.account,&remote)?;
                tx.execute("DELETE FROM graph_delta WHERE account=?1 AND folder_id=?2",params![lease.account,remote])?;
                tx.commit()?;return Err(e.into());
            }
            Err(e)=>return Err(e.into()),
        };
        let next=page.checkpoint.context("missing Graph checkpoint")?;
        // Validate disk persistence scope using the same production origin.
        unpack(&pack(&next),&lease.account,&remote)?;
        let mut staged=HashMap::new();
        for item in page.items {
            checked_id(&item.id,&lease.account,ResourceKind::Message)?;
            let key=item.id.opaque().to_owned();
            if item.fields.removed.is_some() { staged.insert(key,(json!({}),true));continue; }
            let prior=if let Some((v,_))=staged.get(&key){Some(v.to_string())}else{
                let conn=db.lock().unwrap();check(&conn,lease)?;
                let staged=conn.query_row("SELECT fields FROM graph_staged_items WHERE account=?1 AND folder_id=?2 AND remote_id=?3",params![lease.account,remote,key],|r|r.get::<_,String>(0)).optional()?;
                match staged {Some(v)=>Some(v),None=>conn.query_row("SELECT fields FROM graph_items WHERE account=?1 AND remote_id=?2",params![lease.account,key],|r|r.get::<_,String>(0)).optional()?}
            };
            let mut merged=merge_fields(prior.as_deref(),&fields_json(&item.fields))?;
            if !metadata_complete(&merged) {
                check(&db.lock().unwrap(),lease)?;
                let full_item=source.message(&item.id)?;
                checked_id(&full_item.id,&lease.account,ResourceKind::Message)?;
                if full_item.id!=item.id { return Err(Error::new(ErrorKind::InvalidResponse).into()); }
                merged=merge_fields(None,&fields_json(&full_item.fields))?;
            }
            if !metadata_complete(&merged) || (!search && merged["parentFolderId"].as_str()!=Some(&remote)) { return Err(Error::new(ErrorKind::InvalidResponse).into()); }
            let fields:MessageFields=serde_json::from_value(merged.clone())?;
            header(&fields,1)?;
            staged.insert(key,(merged,false));
        }
        let conn=db.lock().unwrap();check(&conn,lease)?;
        let tx=conn.unchecked_transaction()?;
        if next.kind==CheckpointKind::NextPage {
            let repeated:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM graph_round_links WHERE account=?1 AND folder_id=?2 AND link=?3)",params![lease.account,remote,next.url],|r|r.get(0))?;
            if repeated { return Err(Error::new(ErrorKind::InvalidResponse).into()); }
            tx.execute("INSERT INTO graph_round_links(account,folder_id,link) VALUES(?1,?2,?3)",params![lease.account,remote,next.url])?;
        }
        for (key,(fields,removed)) in &staged {
            tx.execute("INSERT INTO graph_staged_items(account,folder_id,remote_id,fields,removed) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(account,folder_id,remote_id) DO UPDATE SET fields=excluded.fields,removed=excluded.removed",params![lease.account,remote,key,fields.to_string(),removed])?;
        }
        tx.execute("UPDATE graph_profiles SET pages=pages+1,changes=changes+?3,error=NULL,retry_after=NULL WHERE account=?1 AND generation=?2",params![lease.account,lease.generation,staged.len() as i64])?;
        let complete=next.kind==CheckpointKind::Delta;
        if complete {
            project_round(&tx,&lease.account,&remote,folder,full)?;
            tx.execute("INSERT INTO graph_delta(account,folder_id,checkpoint) VALUES(?1,?2,?3) ON CONFLICT(account,folder_id) DO UPDATE SET checkpoint=excluded.checkpoint",params![lease.account,remote,pack(&next)])?;
            clear_round(&tx,&lease.account,&remote)?;
        } else {
            tx.execute("INSERT INTO graph_rounds(account,folder_id,next_checkpoint,full) VALUES(?1,?2,?3,?4) ON CONFLICT(account,folder_id) DO UPDATE SET next_checkpoint=excluded.next_checkpoint",params![lease.account,remote,pack(&next),full])?;
        }
        tx.commit()?;
        Ok(complete)
    })().map_err(clean_error)
}

fn clear_round(tx: &Transaction, account: &str, folder: &str) -> anyhow::Result<()> {
    for table in ["graph_staged_items", "graph_round_links", "graph_rounds"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE account=?1 AND folder_id=?2"),
            params![account, folder],
        )?;
    }
    Ok(())
}
fn remove_membership(
    tx: &Transaction,
    account: &str,
    remote_folder: &str,
    local_folder: &str,
    item: &str,
) -> anyhow::Result<()> {
    tx.execute("DELETE FROM messages WHERE account=?1 AND folder=?2 AND uid=(SELECT uid FROM graph_items WHERE account=?1 AND remote_id=?3)",params![account,local_folder,item])?;
    tx.execute(
        "DELETE FROM graph_memberships WHERE account=?1 AND folder_id=?2 AND remote_id=?3",
        params![account, remote_folder, item],
    )?;
    Ok(())
}
fn project_round(
    tx: &Transaction,
    account: &str,
    remote: &str,
    folder: &str,
    full: bool,
) -> anyhow::Result<()> {
    if full {
        let mut stmt=tx.prepare("SELECT remote_id FROM graph_memberships m WHERE account=?1 AND folder_id=?2 AND NOT EXISTS(SELECT 1 FROM graph_staged_items s WHERE s.account=m.account AND s.folder_id=m.folder_id AND s.remote_id=m.remote_id AND s.removed=0)")?;
        let missing = stmt
            .query_map(params![account, remote], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for id in missing {
            remove_membership(tx, account, remote, folder, &id)?;
        }
    }
    let mut stmt=tx.prepare("SELECT remote_id,fields,removed FROM graph_staged_items WHERE account=?1 AND folder_id=?2 ORDER BY remote_id")?;
    let rows = stmt.query_map(params![account, remote], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, bool>(2)?,
        ))
    })?;
    for row in rows {
        let (id, blob, removed) = row?;
        if removed {
            remove_membership(tx, account, remote, folder, &id)?;
            continue;
        }
        let fields: MessageFields = serde_json::from_str(&blob)?;
        let previous: Option<(u32, String)> = tx
            .query_row(
                "SELECT uid,fields FROM graph_items WHERE account=?1 AND remote_id=?2",
                params![account, id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let uid = if let Some((uid, _)) = &previous {
            *uid
        } else {
            let next: i64 = tx.query_row(
                "SELECT COALESCE(MAX(uid),0)+1 FROM graph_items WHERE account=?1",
                [account],
                |r| r.get(0),
            )?;
            u32::try_from(next).context("Graph surrogate capacity exhausted")?
        };
        let h = header(&fields, uid)?;
        tx.execute("INSERT INTO graph_items(account,remote_id,uid,fields) VALUES(?1,?2,?3,?4) ON CONFLICT(account,remote_id) DO UPDATE SET fields=excluded.fields",params![account,id,uid,blob])?;
        tx.execute(
            "INSERT OR IGNORE INTO graph_memberships(account,folder_id,remote_id) VALUES(?1,?2,?3)",
            params![account, remote, id],
        )?;
        crate::store::upsert_messages_in_transaction(
            tx,
            account,
            folder,
            std::slice::from_ref(&h),
        )?;
        // Explicit empty remote lists clear old values; preserve local JSON keys.
        let lists = json!({"to":h.to,"cc":h.cc});
        let indexed =
            h.to.iter()
                .chain(&h.cc)
                .map(|r| format!("{} {}", r.name, r.addr))
                .collect::<Vec<_>>()
                .join(" ");
        tx.execute("UPDATE messages SET json=json_patch(json,?4),recipients=?5 WHERE account=?1 AND folder=?2 AND uid=?3",params![account,folder,uid,lists.to_string(),indexed])?;
        if previous.as_ref().is_some_and(|(_, old)| {
            serde_json::from_str::<Value>(old)
                .ok()
                .and_then(|v| v["@odata.etag"].as_str().map(str::to_owned))
                != fields.etag
        }) {
            tx.execute("UPDATE messages SET body=NULL,json=json_remove(json,'$.body_html') WHERE account=?1 AND folder=?2 AND uid=?3",params![account,folder,uid])?;
        }
        if fields.body.is_some() {
            crate::store::save_cached_message(
                tx,
                account,
                folder,
                uid,
                &parsed_body(&fields, uid)?,
            )?;
        }
    }
    let next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(uid),0)+1 FROM graph_items WHERE account=?1",
        [account],
        |r| r.get(0),
    )?;
    crate::store::set_folder_state(
        tx,
        account,
        folder,
        1,
        u32::try_from(next).context("Graph surrogate capacity exhausted")?,
    )?;
    Ok(())
}
fn parsed_body(fields: &MessageFields, uid: u32) -> Result<crate::parse::Message> {
    let h = header(fields, uid)?;
    let body = fields
        .body
        .as_ref()
        .ok_or_else(|| Error::new(ErrorKind::InvalidResponse))?;
    let (text, html) = match body.content_type.to_ascii_lowercase().as_str() {
        "html" => (
            crate::parse::render_body(&body.content),
            Some(body.content.clone()),
        ),
        "text" => (body.content.clone(), None),
        _ => return invalid(),
    };
    let addresses = |rs: &[crate::imap::Recipient]| {
        rs.iter()
            .map(|r| {
                if r.name.is_empty() {
                    r.addr.clone()
                } else {
                    format!("{} <{}>", r.name, r.addr)
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    Ok(crate::parse::Message {
        subject: h.subject,
        from_name: h.from_name,
        from_addr: h.from_addr,
        to: addresses(&h.to),
        cc: addresses(&h.cc),
        message_id: h.message_id,
        date: h.date,
        preview: text.chars().take(160).collect(),
        body: text,
        body_html: html,
        body_is_rendered: true,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests;

pub fn unsupported<T>() -> anyhow::Result<T> {
    anyhow::bail!("Microsoft Graph is read-only: this operation is not supported")
}

pub fn decorate_folders(
    conn: &Connection,
    account: &str,
    folders: &mut Value,
) -> anyhow::Result<()> {
    let mut stmt=conn.prepare("SELECT f.local_name,COALESCE(p.local_name,'') FROM graph_folders f LEFT JOIN graph_folders p ON p.account=f.account AND p.remote_id=f.parent_id AND p.active=1 WHERE f.account=?1 AND f.active=1")?;
    let parents = stmt
        .query_map([account], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    if let Some(items) = folders.as_array_mut() {
        for f in items {
            if let Some(parent) = f
                .get("name")
                .and_then(Value::as_str)
                .and_then(|name| parents.get(name))
            {
                f["parent_id"] = json!(parent);
            }
        }
    }
    Ok(())
}

/// Preflight before optimistic/local writes or outbound work, not just at the
/// protocol session. Local labels and local draft records are not deleted.
pub fn guard_command(conn: &Connection, method: &str, p: &Value) -> anyhow::Result<()> {
    let blocked = matches!(
        method,
        "send"
            | "save_draft"
            | "discard_draft"
            | "messages.saveRaw"
            | "messages.markRead"
            | "messages.markStarred"
            | "messages.delete"
            | "messages.move"
            | "messages.copy"
            | "messages.markAllRead"
            | "messages.markAllReadUnified"
            | "messages.emptyFolder"
            | "folders.create"
            | "folders.delete"
            | "mail.scheduleSend"
            | "oof.set"
            | "labels.link"
            | "calendar.createCalendar"
            | "calendar.renameCalendar"
            | "calendar.deleteCalendar"
            | "calendar.create"
            | "calendar.update"
            | "calendar.delete"
            | "calendar.respond"
    );
    if !blocked {
        return Ok(());
    }
    if method == "messages.markAllReadUnified" {
        let graph:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE json_extract(config,'$.auth_type')='graph_oauth' AND COALESCE(json_extract(prefs,'$.included_in_unified'),1)=1)",[],|r|r.get(0))?;
        if graph {
            return unsupported();
        }
    }
    fn visit(conn: &Connection, v: &Value) -> anyhow::Result<()> {
        match v {
            Value::Object(o) => {
                for (k, v) in o {
                    if matches!(
                        k.as_str(),
                        "account"
                            | "account_id"
                            | "target_account"
                            | "target_account_id"
                            | "source_account"
                            | "source_account_id"
                    ) {
                        if let Some(id) = v.as_str() {
                            if crate::store::load_account(conn, id)?.is_some_and(|c| c.is_graph()) {
                                return unsupported();
                            }
                        }
                    }
                    visit(conn, v)?;
                }
            }
            Value::Array(a) => {
                for v in a {
                    visit(conn, v)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(conn, p)
}

/// Publish only a complete initial projection. No bearer enters account config.
fn publish(conn: &Connection, lease: &Lease) -> Result<()> {
    (||->anyhow::Result<()>{
        check(conn,lease)?;
        let tx=conn.unchecked_transaction()?;
        let ready:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM graph_profiles p JOIN graph_folders f ON f.account=p.account AND f.role='inbox' AND f.active=1 JOIN graph_delta d ON d.account=f.account AND d.folder_id=f.remote_id WHERE p.account=?1 AND p.generation=?2 AND p.tree_ready=1 AND NOT EXISTS(SELECT 1 FROM graph_rounds r WHERE r.account=f.account AND r.folder_id=f.remote_id))",params![lease.account,lease.generation],|r|r.get(0))?;
        if !ready {return Err(Error::new(ErrorKind::InvalidResponse).into());}
        let existing:Option<String>=tx.query_row("SELECT COALESCE(json_extract(config,'$.auth_type'),'') FROM accounts WHERE id=?1",[&lease.account],|r|r.get(0)).optional()?;
        if existing.as_deref().is_some_and(|v|v!="graph_oauth") {return Err(Error::new(ErrorKind::AccountConflict).into());}
        let config=json!({"auth_type":"graph_oauth","user":lease.account,"proxy":{"mode":"global"}}).to_string();
        tx.execute("INSERT INTO accounts(id,engine,provider,email,display_name,avatar_url,config,created_at,updated_at,sender_name,sort_order) SELECT account,'mail','outlook',account,display_name,'',?3,?4,?4,'',COALESCE((SELECT MAX(sort_order)+1 FROM accounts),0) FROM graph_profiles WHERE account=?1 AND generation=?2 ON CONFLICT(id) DO NOTHING",params![lease.account,lease.generation,config,chrono::Utc::now().timestamp()])?;
        tx.execute("UPDATE graph_profiles SET state='ready',error=NULL,retry_after=NULL WHERE account=?1 AND generation=?2",params![lease.account,lease.generation])?;
        tx.commit()?;
        Ok(())
    })().map_err(clean_error)
}

/// The one per-account lock is shared by activation, sync and body fetches.
/// Cancellation uses the DB generation, not this network-work lock.
pub struct Service {
    db: Db,
    auth: Arc<auth::NativeManager>,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}
impl Service {
    pub fn new(db: Db, auth: Arc<auth::NativeManager>) -> Self {
        Self {
            db,
            auth,
            locks: Mutex::new(HashMap::new()),
        }
    }
    fn lock(&self, account: &str) -> Arc<Mutex<()>> {
        self.locks
            .lock()
            .unwrap()
            .entry(account.into())
            .or_default()
            .clone()
    }
    pub fn session(&self, account: &str) -> Result<Session> {
        let conn = self.db.lock().unwrap();
        let generation = conn
            .query_row(
                "SELECT generation FROM graph_profiles WHERE account=?1 AND state!='cancelled'",
                [account],
                |r| r.get(0),
            )
            .map_err(|_| Error::new(ErrorKind::Reauthenticate))?;
        let proxy = crate::store::load_account(&conn, account)
            .map_err(|_| Error::new(ErrorKind::Storage))?
            .filter(|c| c.is_graph())
            .ok_or_else(|| Error::new(ErrorKind::Reauthenticate))?
            .proxy;
        Ok(Session {
            db: self.db.clone(),
            lease: Lease {
                account: account.into(),
                generation,
            },
            source: Arc::new(NativeSource {
                account: account.into(),
                auth: self.auth.clone(),
                proxy,
            }),
            lock: self.lock(account),
        })
    }
    pub fn activate(self: &Arc<Self>, attempt: &str, name: &str) -> Result<Lease> {
        let authorized = self.auth.poll(attempt);
        if authorized.state != "authorized" {
            return Err(Error::new(ErrorKind::Reauthenticate));
        }
        let account = authorized
            .account
            .ok_or_else(|| Error::new(ErrorKind::InvalidResponse))?;
        let principal = authorized
            .principal
            .ok_or_else(|| Error::new(ErrorKind::InvalidResponse))?;
        let proxy = crate::store::load_account(&self.db.lock().unwrap(), &account)
            .map_err(clean_error)?
            .map(|c| c.proxy)
            .unwrap_or(crate::proxy::ProxyChoice::Global);
        let lease = begin_profile(&self.db.lock().unwrap(), &account, &principal, name)?;
        let session = Session {
            db: self.db.clone(),
            lease: lease.clone(),
            source: Arc::new(NativeSource {
                account: account.clone(),
                auth: self.auth.clone(),
                proxy,
            }),
            lock: self.lock(&account),
        };
        tokio::task::spawn_blocking(move || {
            let _guard = session.lock.lock().unwrap();
            let result = (|| {
                sync_tree(session.source.as_ref(), &session.db, &session.lease)?;
                while !sync_page(
                    session.source.as_ref(),
                    &session.db,
                    &session.lease,
                    "INBOX",
                )? {}
                publish(&session.db.lock().unwrap(), &session.lease)
            })();
            if let Err(e) = result {
                let _ = record_failure(&session.db.lock().unwrap(), &session.lease, &e);
            }
        });
        Ok(lease)
    }
}

#[derive(Clone)]
pub struct Session {
    db: Db,
    lease: Lease,
    source: Arc<dyn Source>,
    lock: Arc<Mutex<()>>,
}
impl Session {
    async fn work<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Self) -> Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let this = self.clone();
        Ok(tokio::task::spawn_blocking(move || {
            let _guard = this.lock.lock().unwrap();
            check(&this.db.lock().unwrap(), &this.lease).map_err(clean_error)?;
            let result = f(&this);
            if let Err(e) = &result {
                let _ = record_failure(&this.db.lock().unwrap(), &this.lease, e);
            }
            result
        })
        .await??)
    }
    pub async fn sync_tree(&self) -> anyhow::Result<Vec<crate::imap::Folder>> {
        self.work(|s| {
            sync_tree(s.source.as_ref(), &s.db, &s.lease)?;
            crate::store::get_folders(&s.db.lock().unwrap(), &s.lease.account).map_err(clean_error)
        })
        .await
    }
    pub async fn sync_folder(
        &self,
        folder: &str,
        limit: u32,
    ) -> anyhow::Result<crate::imap::RecentBatch> {
        let folder = folder.to_owned();
        self.work(move |s| {
            while !sync_page(s.source.as_ref(), &s.db, &s.lease, &folder)? {}
            s.cached_recent(&folder, limit).map_err(clean_error)
        })
        .await
    }
    pub fn list_folders(&self) -> anyhow::Result<Vec<crate::imap::Folder>> {
        let conn = self.db.lock().unwrap();
        check(&conn, &self.lease)?;
        crate::store::get_folders(&conn, &self.lease.account)
    }
    pub fn cached_recent(
        &self,
        folder: &str,
        limit: u32,
    ) -> anyhow::Result<crate::imap::RecentBatch> {
        let conn = self.db.lock().unwrap();
        check(&conn, &self.lease)?;
        let (_, next) =
            crate::store::get_folder_state(&conn, &self.lease.account, folder)?.unwrap_or((1, 1));
        Ok(crate::imap::RecentBatch {
            uidvalidity: 1,
            uid_next: next,
            messages: crate::store::recent_headers(
                &conn,
                &self.lease.account,
                folder,
                i64::from(limit),
            )?,
        })
    }
    pub async fn read_message(
        &self,
        folder: &str,
        uid: u32,
    ) -> anyhow::Result<crate::parse::Message> {
        let folder = folder.to_owned();
        self.work(move|s|{
            (||->anyhow::Result<crate::parse::Message>{
                let account=&s.lease.account;
                let id={let conn=s.db.lock().unwrap();check(&conn,&s.lease)?;
                    if let Some(cached)=crate::store::get_cached_message(&conn,account,&folder,uid)? {return Ok(cached);}
                    conn.query_row("SELECT i.remote_id FROM graph_items i JOIN graph_memberships m ON m.account=i.account AND m.remote_id=i.remote_id JOIN graph_folders f ON f.account=m.account AND f.remote_id=m.folder_id WHERE i.account=?1 AND i.uid=?2 AND f.local_name=?3 AND f.active=1",params![account,uid,folder],|r|r.get::<_,String>(0))?
                };
                let id=ResourceId::new(account,ResourceKind::Message,&id)?;
                let message=s.source.message(&id)?;
                if message.id!=id {return Err(Error::new(ErrorKind::InvalidResponse).into());}
                let body=parsed_body(&message.fields,uid)?;
                let conn=s.db.lock().unwrap();check(&conn,&s.lease)?;
                crate::store::save_cached_message(&conn,account,&folder,uid,&body)?;
                Ok(body)
            })().map_err(clean_error)
        }).await
    }
    pub async fn fetch_bodies(
        &self,
        folder: &str,
        uids: &[u32],
    ) -> anyhow::Result<Vec<(u32, crate::parse::Message)>> {
        let mut result = Vec::with_capacity(uids.len());
        for uid in uids {
            result.push((*uid, self.read_message(folder, *uid).await?));
        }
        Ok(result)
    }
}
