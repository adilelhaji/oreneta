//! The mailbox's Contacts folder: its people, read only, and its
//! distribution lists, read and written (ADR-0058).
//!
//! A distribution list is Exchange's contact group. It names its members as
//! mailboxes: a contact of the same folder (by item id), an address typed in
//! (a one-off) or an entry of the organisation's directory. Each member has a
//! key the server gave it, which is how one member is taken out without
//! rewriting the others.
//!
//! Every write names the change key the list was read at and asks the server
//! never to overwrite (`ConflictResolution="NeverOverwrite"`): a list changed
//! elsewhere since is refused there and nothing is written (ADR-0012).

use anyhow::{bail, Context as _, Result};

use super::soap::{self, escape, Node};
use super::EwsClient;
use crate::contacts::person::{EmailAddress, Person, PhoneNumber};

/// How many items one `GetItem` asks for.
const BATCH: usize = 100;
/// How many items one page of the folder listing holds.
const PAGE: usize = 500;

/// A contact of the folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contact {
    pub change_key: String,
    /// `uid` is the item id: stable for the life of the contact.
    pub person: Person,
}

/// One member of a distribution list as the server holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Member {
    /// The server's key for this membership, used to take it out.
    pub key: String,
    pub name: String,
    /// An address mail can go to; empty when the server gave a directory
    /// identifier instead, which is not one.
    pub addr: String,
    /// The contact or list it points at, by item id, when it points at one.
    pub item_id: Option<String>,
}

impl Member {
    /// The member's id in the book: the contact's item id, or `mailto:` and
    /// the address for somebody who is no contact here. `None` for an entry
    /// with neither, which is kept on the server but cannot be named here.
    pub fn uid(&self) -> Option<String> {
        self.item_id.clone().or_else(|| (!self.addr.is_empty()).then(|| format!("mailto:{}", self.addr)))
    }
}

/// A distribution list as the server holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DistributionList {
    pub id: String,
    pub change_key: String,
    pub name: String,
    pub members: Vec<Member>,
}

/// Everything in the Contacts folder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Book {
    pub contacts: Vec<Contact>,
    pub lists: Vec<DistributionList>,
}

/// A member to add: a contact of the folder, or an address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMember {
    pub item_id: Option<String>,
    pub name: String,
    pub addr: String,
}

/// What became of a write to a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListWrite {
    /// Written; the list's change key now.
    Saved { id: String, change_key: String },
    /// Changed or deleted on the server since it was read: nothing written.
    Conflict,
}

/// An address mail can go to, from what the server gave. `smtp:` prefixes
/// go; a directory identifier (`/O=…`) or anything without `@` is not one.
fn address(raw: &str) -> String {
    let raw = raw.trim();
    let raw = raw.strip_prefix("SMTP:").or_else(|| raw.strip_prefix("smtp:")).unwrap_or(raw);
    if raw.starts_with('/') || !raw.contains('@') {
        String::new()
    } else {
        raw.to_lowercase()
    }
}

fn phone_label(key: &str) -> String {
    match key {
        "MobilePhone" => "cell",
        "BusinessPhone" | "BusinessPhone2" => "work",
        "HomePhone" | "HomePhone2" => "home",
        "BusinessFax" | "HomeFax" | "OtherFax" => "fax",
        _ => "",
    }
    .to_string()
}

fn contact(node: &Node) -> Option<Contact> {
    let id = node.child("ItemId")?;
    let mut emails: Vec<EmailAddress> = Vec::new();
    for entry in node.path(&["EmailAddresses"]).map(|list| list.children_named("Entry").collect::<Vec<_>>()).unwrap_or_default() {
        let addr = address(&entry.text);
        if !addr.is_empty() && !emails.iter().any(|known| known.addr == addr) {
            // Exchange numbers the addresses (EmailAddress1–3) rather than
            // saying what each is for, so they carry no label.
            emails.push(EmailAddress { addr, label: String::new() });
        }
    }
    let phones = node
        .path(&["PhoneNumbers"])
        .map(|list| {
            list.children_named("Entry")
                .filter(|entry| !entry.text.trim().is_empty())
                .map(|entry| PhoneNumber {
                    number: entry.text.trim().to_string(),
                    label: phone_label(entry.attr("Key").unwrap_or_default()),
                })
                .collect()
        })
        .unwrap_or_default();
    let given = node.text_of("GivenName").unwrap_or_default().to_string();
    let family = node.text_of("Surname").unwrap_or_default().to_string();
    let name = [node.text_of("DisplayName"), node.text_of("FileAs"), node.text_of("Subject")]
        .into_iter()
        .flatten()
        .find(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| [given.as_str(), family.as_str()].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" "));
    let person = Person {
        uid: id.attr("Id")?.to_string(),
        name,
        given,
        family,
        organisation: node.text_of("CompanyName").unwrap_or_default().to_string(),
        emails,
        phones,
        ..Default::default()
    };
    Some(Contact { change_key: id.attr("ChangeKey").unwrap_or_default().to_string(), person })
}

fn member(node: &Node) -> Option<Member> {
    let mailbox = node.child("Mailbox")?;
    Some(Member {
        key: node.attr("Key").unwrap_or_default().to_string(),
        name: mailbox.text_of("Name").unwrap_or_default().to_string(),
        addr: address(mailbox.text_of("EmailAddress").unwrap_or_default()),
        item_id: mailbox.child("ItemId").and_then(|id| id.attr("Id")).map(str::to_string),
    })
}

fn list(node: &Node) -> Option<DistributionList> {
    let id = node.child("ItemId")?;
    Some(DistributionList {
        id: id.attr("Id")?.to_string(),
        change_key: id.attr("ChangeKey").unwrap_or_default().to_string(),
        name: [node.text_of("DisplayName"), node.text_of("Subject")]
            .into_iter()
            .flatten()
            .find(|name| !name.is_empty())
            .unwrap_or_default()
            .to_string(),
        members: node
            .child("Members")
            .map(|members| members.children_named("Member").filter_map(member).collect())
            .unwrap_or_default(),
    })
}

/// One `<t:Member>` to write.
fn member_xml(member: &NewMember) -> String {
    let name = if member.name.trim().is_empty() {
        String::new()
    } else {
        format!("<t:Name>{}</t:Name>", escape(member.name.trim()))
    };
    match &member.item_id {
        // A contact of the folder, by its item id, with the address it is
        // reached at.
        Some(id) => format!(
            "<t:Member><t:Mailbox>{name}<t:EmailAddress>{}</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType><t:MailboxType>Contact</t:MailboxType>{}</t:Mailbox></t:Member>",
            escape(&member.addr),
            soap::item_id(id, None)
        ),
        None => format!(
            "<t:Member><t:Mailbox>{name}<t:EmailAddress>{}</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType><t:MailboxType>OneOff</t:MailboxType></t:Mailbox></t:Member>",
            escape(&member.addr)
        ),
    }
}

impl EwsClient {
    fn contacts_folder(&self) -> String {
        soap::distinguished("contacts", &self.config.target_mailbox)
    }

    /// The item ids of everything in the Contacts folder, page by page.
    fn contact_ids(&self) -> Result<Vec<(String, String)>> {
        let mut ids = Vec::new();
        let mut offset = 0usize;
        loop {
            let document = self.call_raw(&format!(
                r#"<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="{PAGE}" Offset="{offset}" BasePoint="Beginning"/><m:ParentFolderIds>{}</m:ParentFolderIds></m:FindItem>"#,
                self.contacts_folder()
            ))?;
            let message = soap::single(&document, "FindItem").context("FindItem contacts")?;
            let root = message.child("RootFolder").context("the contacts listing has no root folder")?;
            let before = ids.len();
            if let Some(items) = root.child("Items") {
                for item in &items.children {
                    if let Some(id) = item.child("ItemId").and_then(|id| id.attr("Id")) {
                        ids.push((item.name.clone(), id.to_string()));
                    }
                }
            }
            if root.attr("IncludesLastItemInRange") != Some("false") {
                break;
            }
            if ids.len() == before {
                bail!("the contacts listing stopped giving items before its end");
            }
            offset = ids.len();
        }
        Ok(ids)
    }

    /// Items by id, with all their properties, in batches. An item gone
    /// between the listing and this read is left out; any other refusal
    /// fails the read, so a book is never replaced by part of itself.
    fn items(&self, ids: &[String]) -> Result<Vec<Node>> {
        let mut out = Vec::new();
        for batch in ids.chunks(BATCH) {
            let wanted: String = batch.iter().map(|id| soap::item_id(id, None)).collect();
            let document = self.call_raw(&format!(
                "<m:GetItem><m:ItemShape><t:BaseShape>AllProperties</t:BaseShape></m:ItemShape><m:ItemIds>{wanted}</m:ItemIds></m:GetItem>"
            ))?;
            for message in soap::messages(&document, "GetItem")? {
                match message {
                    Ok(message) => {
                        if let Some(items) = message.child("Items") {
                            out.extend(items.children.iter().cloned());
                        }
                    }
                    Err(error) if error.code == "ErrorItemNotFound" => {}
                    Err(error) => return Err(anyhow::Error::new(error).context("GetItem contacts")),
                }
            }
        }
        Ok(out)
    }

    /// The whole Contacts folder: its contacts and its distribution lists.
    pub fn read_book(&self) -> Result<Book> {
        let ids: Vec<String> = self
            .contact_ids()?
            .into_iter()
            .filter(|(kind, _)| kind == "Contact" || kind == "DistributionList")
            .map(|(_, id)| id)
            .collect();
        let mut book = Book::default();
        for item in self.items(&ids)? {
            match item.name.as_str() {
                "Contact" => book.contacts.extend(contact(&item)),
                "DistributionList" => book.lists.extend(list(&item)),
                _ => {}
            }
        }
        Ok(book)
    }

    /// One list as the server holds it now; `None` when it is gone.
    pub fn read_list(&self, id: &str) -> Result<Option<DistributionList>> {
        Ok(self.items(&[id.to_string()])?.iter().find(|item| item.name == "DistributionList").and_then(list))
    }

    /// Creates a list in the Contacts folder.
    pub fn create_list(&self, name: &str, members: &[NewMember]) -> Result<(String, String)> {
        let members: String = members.iter().map(member_xml).collect();
        let members = if members.is_empty() { String::new() } else { format!("<t:Members>{members}</t:Members>") };
        let document = self.call_raw(&format!(
            "<m:CreateItem><m:SavedItemFolderId>{}</m:SavedItemFolderId><m:Items><t:DistributionList><t:DisplayName>{}</t:DisplayName>{members}</t:DistributionList></m:Items></m:CreateItem>",
            self.contacts_folder(),
            escape(name)
        ))?;
        let message = soap::single(&document, "CreateItem").context("CreateItem distribution list")?;
        let id = message
            .path(&["Items", "DistributionList", "ItemId"])
            .context("Exchange did not say which list it created")?;
        Ok((
            id.attr("Id").context("Exchange did not say which list it created")?.to_string(),
            id.attr("ChangeKey").unwrap_or_default().to_string(),
        ))
    }

    /// Renames a list and adds and takes out members, from the change key it
    /// was read at. Only what changed is sent: a member the change does not
    /// name stays as it is on the server.
    pub fn update_list(
        &self,
        id: &str,
        read_at: &str,
        rename: Option<&str>,
        add: &[NewMember],
        remove_keys: &[String],
    ) -> Result<ListWrite> {
        // Never written blind: without the version it was read at, a change
        // made since could not be told apart (ADR-0012).
        if read_at.is_empty() {
            return Ok(ListWrite::Conflict);
        }
        let mut updates = String::new();
        if let Some(name) = rename {
            updates.push_str(&format!(
                r#"<t:SetItemField><t:FieldURI FieldURI="contacts:DisplayName"/><t:DistributionList><t:DisplayName>{}</t:DisplayName></t:DistributionList></t:SetItemField>"#,
                escape(name)
            ));
        }
        if !add.is_empty() {
            let members: String = add.iter().map(member_xml).collect();
            updates.push_str(&format!(
                r#"<t:AppendToItemField><t:FieldURI FieldURI="distributionlist:Members"/><t:DistributionList><t:Members>{members}</t:Members></t:DistributionList></t:AppendToItemField>"#
            ));
        }
        for key in remove_keys {
            updates.push_str(&format!(
                r#"<t:DeleteItemField><t:IndexedFieldURI FieldURI="distributionlist:Members:Member" FieldIndex="{}"/></t:DeleteItemField>"#,
                escape(key)
            ));
        }
        if updates.is_empty() {
            return Ok(ListWrite::Saved { id: id.to_string(), change_key: read_at.to_string() });
        }
        let document = self.call_raw(&format!(
            r#"<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="NeverOverwrite"><m:ItemChanges><t:ItemChange>{}<t:Updates>{updates}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>"#,
            soap::item_id(id, Some(read_at))
        ))?;
        written(&document, "UpdateItem", "DistributionList", id)
    }

    /// Deletes a list to Deleted Items, from the change key it was read at.
    /// `DeleteItem` does not compare change keys itself, so the list is read
    /// first: one changed or gone since answers a conflict and nothing is
    /// deleted.
    pub fn delete_list(&self, id: &str, read_at: &str) -> Result<ListWrite> {
        if read_at.is_empty() {
            return Ok(ListWrite::Conflict);
        }
        match self.read_list(id)? {
            None => return Ok(ListWrite::Saved { id: id.to_string(), change_key: String::new() }),
            Some(current) if current.change_key != read_at => return Ok(ListWrite::Conflict),
            Some(_) => {}
        }
        let document = self.call_raw(&format!(
            r#"<m:DeleteItem DeleteType="MoveToDeletedItems"><m:ItemIds>{}</m:ItemIds></m:DeleteItem>"#,
            soap::item_id(id, Some(read_at))
        ))?;
        match soap::single(&document, "DeleteItem") {
            Ok(_) => Ok(ListWrite::Saved { id: id.to_string(), change_key: String::new() }),
            Err(error) if soap::error_code(&error) == Some("ErrorItemNotFound") => {
                Ok(ListWrite::Saved { id: id.to_string(), change_key: String::new() })
            }
            Err(error) => Err(error),
        }
    }
}

/// The outcome of a write to one item: its change key now, or a conflict
/// when the server refused it as changed (or gone) since it was read.
pub(crate) fn written(document: &Node, operation: &str, kind: &str, id: &str) -> Result<ListWrite> {
    match soap::single(document, operation) {
        Ok(message) => {
            let change_key = message
                .path(&["Items", kind, "ItemId"])
                .and_then(|item| item.attr("ChangeKey"))
                .unwrap_or_default()
                .to_string();
            Ok(ListWrite::Saved { id: id.to_string(), change_key })
        }
        Err(error)
            if matches!(
                soap::error_code(&error),
                Some("ErrorIrresolvableConflict" | "ErrorStaleObject" | "ErrorItemNotFound")
            ) =>
        {
            Ok(ListWrite::Conflict)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
pub(crate) mod tests;
