//! The mailbox's contact folders: the Contacts folder and the contact folders
//! under it, each with its people and its distribution lists, all read and
//! written (ADR-0058, ADR-0064).
//!
//! A distribution list is Exchange's contact group. It names its members as
//! mailboxes: a contact of the same folder (by item id), an address typed in
//! (a one-off) or an entry of the organisation's directory. Each member has a
//! key the server gave it, which is how one member is taken out without
//! rewriting the others.
//!
//! A contact keeps its addresses and phone numbers in numbered slots
//! (`EmailAddress1`–`3`, `MobilePhone`, `BusinessPhone`…). An edit keeps
//! every slot whose value is unchanged, clears the ones taken out and puts a
//! new value in a free slot; a change with no free slot fails before anything
//! is sent.
//!
//! Every write names the change key the item was read at and asks the server
//! never to overwrite (`ConflictResolution="NeverOverwrite"`): an item changed
//! elsewhere since is refused there and nothing is written (ADR-0012).

use std::collections::HashMap;

use anyhow::{bail, Context as _, Result};

use super::soap::{self, escape, Node};
use super::EwsClient;
use crate::contacts::person::{EmailAddress, Person, PhoneNumber};

/// How many items one `GetItem` asks for.
const BATCH: usize = 100;
/// How many items (or folders) one page of a listing holds.
const PAGE: usize = 500;

/// The named property holding our id for a contact created here, so that a
/// creation whose answer was lost is found again rather than made twice.
const MARKER: &str = r#"<t:ExtendedFieldURI DistinguishedPropertySetId="PublicStrings" PropertyName="OrenetaContactUid" PropertyType="String"/>"#;

/// Whether a folder is hidden (`PR_ATTR_HIDDEN`): the system keeps such
/// folders for itself.
const HIDDEN: &str = r#"<t:ExtendedFieldURI PropertyTag="0x10F4" PropertyType="Boolean"/>"#;

/// The e-mail slots a contact has.
const EMAIL_KEYS: [&str; 3] = ["EmailAddress1", "EmailAddress2", "EmailAddress3"];

/// Where a new number goes when nothing says better: the slots a person
/// would look in for a voice number, in order. Faxes, pagers and the like are
/// left out, so a number typed with no label never lands in one.
const VOICE_KEYS: [&str; 9] = [
    "OtherTelephone",
    "PrimaryPhone",
    "MobilePhone",
    "BusinessPhone",
    "HomePhone",
    "BusinessPhone2",
    "HomePhone2",
    "CompanyMainPhone",
    "CarPhone",
];

/// A contact folder under the mailbox's Contacts folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactFolder {
    pub id: String,
    /// Its names from the Contacts folder down, joined with `/`.
    pub path: String,
}

/// A contact of a folder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Contact {
    pub change_key: String,
    /// `uid` is the item id: stable for the life of the contact.
    pub person: Person,
    /// Every e-mail slot that holds something, by key, as written there — a
    /// directory identifier included, which is no address but takes a slot.
    pub email_slots: Vec<(String, String)>,
    /// Every phone slot that holds a number, by key.
    pub phone_slots: Vec<(String, String)>,
    /// The display name as the server holds it; `person.name` falls back
    /// on what the contact is filed as when it has none.
    pub display_name: String,
    /// What the contact is filed as (sorted by in Outlook).
    pub file_as: String,
    /// Our id, when it was created here.
    pub marker: Option<String>,
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

/// Everything in one contact folder.
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

/// What became of a write to a list or a contact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListWrite {
    /// Written; the item's change key now.
    Saved { id: String, change_key: String },
    /// Changed or deleted on the server since it was read: nothing written.
    Conflict,
}

/// What became of a creation that was sent.
#[derive(Debug)]
pub enum Created {
    Made { id: String, change_key: String },
    /// The answer was lost or unreadable: the item may or may not be there.
    Unknown(anyhow::Error),
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

/// An address as it is written to a contact: trimmed, without an `smtp:`
/// prefix, with a local part and a domain and no other scheme (`sip:`) or
/// space. `None` for anything else, which Exchange could not send mail to.
fn writable_address(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let raw = raw.get(..5).filter(|prefix| prefix.eq_ignore_ascii_case("smtp:")).map_or(raw, |_| &raw[5..]);
    let (local, domain) = raw.rsplit_once('@')?;
    let fine = !local.is_empty()
        && !domain.is_empty()
        && !local.contains(':')
        && !raw.starts_with('/')
        && !raw.chars().any(char::is_whitespace);
    fine.then(|| raw.to_string())
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

/// A label as the slots know it: one of `cell`, `work`, `home`, `fax`, or
/// none.
fn label_kind(label: &str) -> &'static str {
    match label.trim().to_ascii_lowercase().as_str() {
        "cell" | "mobile" => "cell",
        "work" => "work",
        "home" => "home",
        "fax" => "fax",
        _ => "",
    }
}

/// The slots a number with this label belongs in, best first.
fn phone_keys(label: &str) -> Vec<&'static str> {
    let own: &[&str] = match label_kind(label) {
        "cell" => &["MobilePhone"],
        "work" => &["BusinessPhone", "BusinessPhone2"],
        "home" => &["HomePhone", "HomePhone2"],
        "fax" => &["BusinessFax", "HomeFax", "OtherFax"],
        _ => &[],
    };
    let mut keys: Vec<&'static str> = own.to_vec();
    // A fax only goes in a fax slot; anything else may take any voice slot
    // once its own are full.
    if label_kind(label) != "fax" {
        keys.extend(VOICE_KEYS.iter().filter(|key| !own.contains(key)));
    }
    keys
}

/// The entries of a `<t:EmailAddresses>` or `<t:PhoneNumbers>` that hold
/// something, as `(key, text)`.
fn slots(node: &Node, list: &str) -> Vec<(String, String)> {
    node.child(list)
        .map(|list| {
            list.children_named("Entry")
                .filter(|entry| !entry.text.trim().is_empty())
                .map(|entry| (entry.attr("Key").unwrap_or_default().to_string(), entry.text.trim().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn contact(node: &Node) -> Option<Contact> {
    let id = node.child("ItemId")?;
    let email_slots = slots(node, "EmailAddresses");
    let phone_slots = slots(node, "PhoneNumbers");
    let mut emails: Vec<EmailAddress> = Vec::new();
    for (_, raw) in &email_slots {
        let addr = address(raw);
        if !addr.is_empty() && !emails.iter().any(|known| known.addr == addr) {
            // Exchange numbers the addresses (EmailAddress1–3) rather than
            // saying what each is for, so they carry no label.
            emails.push(EmailAddress { addr, label: String::new() });
        }
    }
    let phones = phone_slots
        .iter()
        .map(|(key, number)| PhoneNumber { number: number.clone(), label: phone_label(key) })
        .collect();
    let given = node.text_of("GivenName").unwrap_or_default().to_string();
    let family = node.text_of("Surname").unwrap_or_default().to_string();
    let display_name = node.text_of("DisplayName").unwrap_or_default().to_string();
    let file_as = node.text_of("FileAs").unwrap_or_default().to_string();
    let name = [Some(display_name.as_str()), Some(file_as.as_str()), node.text_of("Subject")]
        .into_iter()
        .flatten()
        .find(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| [given.as_str(), family.as_str()].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" "));
    let marker = node
        .children_named("ExtendedProperty")
        .find(|property| property.path(&["ExtendedFieldURI"]).and_then(|uri| uri.attr("PropertyName")) == Some("OrenetaContactUid"))
        .and_then(|property| property.text_of("Value"))
        .map(str::to_string);
    let person = Person {
        uid: id.attr("Id")?.to_string(),
        name,
        given,
        family,
        organisation: node.text_of("CompanyName").unwrap_or_default().to_string(),
        note: node.text_of("Body").unwrap_or_default().to_string(),
        emails,
        phones,
        ..Default::default()
    };
    Some(Contact {
        change_key: id.attr("ChangeKey").unwrap_or_default().to_string(),
        person,
        email_slots,
        phone_slots,
        display_name,
        file_as,
        marker,
    })
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

/// The contact folders of a `FindFolder` answer under the Contacts folder:
/// real contact folders only (`IPF.Contact`, not the system's
/// `IPF.Contact.*` ones), none hidden or under a hidden one, each named by
/// its path. A chain of parents that loops (a server error) is cut where it
/// repeats.
pub fn contact_folders_of(folders: &[Node]) -> Vec<ContactFolder> {
    struct Listed {
        name: String,
        parent: Option<String>,
        class: String,
        hidden: bool,
    }
    let mut listed: HashMap<String, Listed> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for folder in folders {
        let Some(id) = folder.child("FolderId").and_then(|id| id.attr("Id")) else { continue };
        let hidden = folder
            .children_named("ExtendedProperty")
            .find(|property| {
                property
                    .path(&["ExtendedFieldURI"])
                    .and_then(|uri| uri.attr("PropertyTag"))
                    .is_some_and(|tag| tag.eq_ignore_ascii_case("0x10f4"))
            })
            .and_then(|property| property.text_of("Value"))
            .is_some_and(|value| value.eq_ignore_ascii_case("true"));
        if !listed.contains_key(id) {
            order.push(id.to_string());
        }
        listed.insert(
            id.to_string(),
            Listed {
                name: folder.text_of("DisplayName").unwrap_or_default().to_string(),
                parent: folder.child("ParentFolderId").and_then(|id| id.attr("Id")).map(str::to_string),
                class: folder.text_of("FolderClass").unwrap_or_default().to_string(),
                hidden,
            },
        );
    }
    let mut out = Vec::new();
    for id in &order {
        let folder = &listed[id];
        if folder.class != "IPF.Contact" {
            continue;
        }
        let mut names = Vec::new();
        let mut seen: Vec<&str> = Vec::new();
        let mut hidden = false;
        let mut at = Some(id.as_str());
        while let Some(current) = at {
            if seen.contains(&current) {
                break;
            }
            let Some(entry) = listed.get(current) else { break };
            seen.push(current);
            hidden |= entry.hidden;
            names.push(entry.name.as_str());
            at = entry.parent.as_deref();
        }
        if hidden {
            continue;
        }
        names.reverse();
        out.push(ContactFolder { id: id.clone(), path: names.join("/") });
    }
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    out
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

/// What to do with one slot: put this value in it, or clear it.
type SlotPlan = Vec<(String, Option<String>)>;

/// Where the wanted addresses go, from the slots the server holds: a slot
/// whose address stays is not touched, one whose address went is cleared or
/// takes a new one, and a new address takes a free slot. A slot holding a
/// directory identifier is no address here but stays taken. Fails, sending
/// nothing, when an address is not one Exchange can keep or there are more
/// than the slots left.
fn email_plan(slots: &[(String, String)], wanted: &[EmailAddress]) -> Result<SlotPlan> {
    // Compared lower-cased, written as typed.
    let mut want: Vec<String> = Vec::new();
    let mut typed: Vec<String> = Vec::new();
    for raw in wanted.iter().map(|email| email.addr.trim()).filter(|addr| !addr.is_empty()) {
        let Some(written) = writable_address(raw) else {
            bail!("“{raw}” is not an email address Exchange can keep");
        };
        let addr = written.to_lowercase();
        if !want.contains(&addr) {
            want.push(addr);
            typed.push(written);
        }
    }
    let usable: Vec<(&str, String)> =
        slots.iter().map(|(key, raw)| (key.as_str(), address(raw))).filter(|(_, addr)| !addr.is_empty()).collect();
    let freed: Vec<&str> = usable.iter().filter(|(_, addr)| !want.contains(addr)).map(|(key, _)| *key).collect();
    let new: Vec<&String> = want.iter().filter(|addr| !usable.iter().any(|(_, held)| held == *addr)).collect();
    let taken: Vec<&str> = slots.iter().map(|(key, _)| key.as_str()).filter(|key| !freed.contains(key)).collect();
    let free: Vec<&str> = EMAIL_KEYS.iter().copied().filter(|key| !taken.contains(key)).collect();
    if new.len() > free.len() {
        bail!("Exchange keeps at most three email addresses for a contact, and this one has no room for {} more", new.len());
    }
    let mut plan: SlotPlan = new
        .iter()
        .zip(&free)
        .map(|(addr, key)| {
            let at = want.iter().position(|known| known == *addr).expect("a wanted address");
            (key.to_string(), Some(typed[at].clone()))
        })
        .collect();
    for key in freed {
        if !plan.iter().any(|(planned, _)| planned == key) {
            plan.push((key.to_string(), None));
        }
    }
    Ok(plan)
}

/// Where the wanted numbers go, from the slots the server holds, by the same
/// rule as [`email_plan`]: a number already in a slot of its kind stays
/// there (one with no label, in any slot it is in); a new or relabelled one
/// takes the first free slot of its kind, then any free voice slot.
fn phone_plan(slots: &[(String, String)], wanted: &[PhoneNumber]) -> Result<SlotPlan> {
    let mut want: Vec<(&str, &str)> = Vec::new();
    for phone in wanted {
        let entry = (phone.number.trim(), phone.label.as_str());
        if !entry.0.is_empty() && !want.iter().any(|(number, label)| *number == entry.0 && label_kind(label) == label_kind(entry.1)) {
            want.push(entry);
        }
    }
    let mut kept = vec![false; slots.len()];
    let mut placed = vec![false; want.len()];
    for exact in [true, false] {
        for (i, (number, label)) in want.iter().enumerate() {
            // A number with a label of its own is kept only in a slot of
            // that kind: one relabelled moves to a slot of the new kind.
            if placed[i] || (!exact && !label_kind(label).is_empty()) {
                continue;
            }
            let found = slots.iter().enumerate().position(|(j, (key, held))| {
                !kept[j] && held.trim() == *number && (!exact || phone_label(key) == label_kind(label))
            });
            if let Some(j) = found {
                kept[j] = true;
                placed[i] = true;
            }
        }
    }
    let freed: Vec<&str> = slots.iter().zip(&kept).filter(|(_, kept)| !**kept).map(|((key, _), _)| key.as_str()).collect();
    let mut taken: Vec<String> =
        slots.iter().map(|(key, _)| key.clone()).filter(|key| !freed.contains(&key.as_str())).collect();
    let mut plan: SlotPlan = Vec::new();
    for (i, (number, label)) in want.iter().enumerate() {
        if placed[i] {
            continue;
        }
        let key = phone_keys(label)
            .into_iter()
            .find(|key| !taken.iter().any(|held| held == key))
            .with_context(|| format!("Exchange has no room on this contact for another phone number like “{number}”"))?;
        taken.push(key.to_string());
        plan.push((key.to_string(), Some(number.to_string())));
    }
    for key in freed {
        if !plan.iter().any(|(planned, _)| planned == key) {
            plan.push((key.to_string(), None));
        }
    }
    Ok(plan)
}

/// A whole `<t:EmailAddresses>` or `<t:PhoneNumbers>` of new values.
fn entries_xml(list: &str, plan: &SlotPlan) -> String {
    let entries: String = plan
        .iter()
        .filter_map(|(key, value)| value.as_ref().map(|value| format!(r#"<t:Entry Key="{}">{}</t:Entry>"#, escape(key), escape(value))))
        .collect();
    if entries.is_empty() {
        String::new()
    } else {
        format!("<t:{list}>{entries}</t:{list}>")
    }
}

/// The updates for one slot list (`contacts:EmailAddress` or
/// `contacts:PhoneNumber`).
fn slot_updates(field: &str, list: &str, plan: &SlotPlan) -> String {
    plan.iter()
        .map(|(key, value)| match value {
            Some(value) => format!(
                r#"<t:SetItemField><t:IndexedFieldURI FieldURI="{field}" FieldIndex="{key}"/><t:Contact><t:{list}><t:Entry Key="{key}">{}</t:Entry></t:{list}></t:Contact></t:SetItemField>"#,
                escape(value),
                key = escape(key)
            ),
            None => format!(r#"<t:DeleteItemField><t:IndexedFieldURI FieldURI="{field}" FieldIndex="{}"/></t:DeleteItemField>"#, escape(key)),
        })
        .collect()
}

/// Sets a plain contact field, or clears it when the new value is empty.
fn text_update(field: &str, element: &str, value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        format!(r#"<t:DeleteItemField><t:FieldURI FieldURI="{field}"/></t:DeleteItemField>"#)
    } else {
        format!(
            r#"<t:SetItemField><t:FieldURI FieldURI="{field}"/><t:Contact><t:{element}>{}</t:{element}></t:Contact></t:SetItemField>"#,
            escape(value)
        )
    }
}

fn differs(before: &str, after: &str) -> bool {
    // Compared as written: a character XML cannot carry is never sent, and
    // must not look like a change; nor must the line ends Exchange gives a
    // note (`\r\n`) against an editor's (`\n`).
    let written = |text: &str| escape(text.trim()).replace("\r\n", "\n").replace('\r', "\n");
    written(before) != written(after)
}

/// The changes that make the contact `before` (as the server holds it) into
/// `after`, each property once. Only what differs is sent: what this client
/// does not show (postal addresses, birthday, job, categories, a directory
/// identifier's slot) is left as it is. Fails, sending nothing, when the
/// change cannot be held (see [`email_plan`] and [`phone_plan`]).
pub fn contact_changes(before: &Contact, after: &Person) -> Result<String> {
    if !after.is_useful() {
        bail!("a contact needs a name or an email address");
    }
    let mut out = String::new();
    if differs(&before.person.name, &after.name) {
        out.push_str(&text_update("contacts:DisplayName", "DisplayName", &after.name));
        // What it is filed as follows the name when it was the display name
        // (or nothing); one filed otherwise on purpose stays, also when the
        // name shown here came from it for want of a display name.
        if before.file_as.trim().is_empty() || before.file_as.trim() == before.display_name.trim() {
            out.push_str(&text_update("contacts:FileAs", "FileAs", &after.name));
        }
    }
    if differs(&before.person.given, &after.given) {
        out.push_str(&text_update("contacts:GivenName", "GivenName", &after.given));
    }
    if differs(&before.person.organisation, &after.organisation) {
        out.push_str(&text_update("contacts:CompanyName", "CompanyName", &after.organisation));
    }
    if differs(&before.person.family, &after.family) {
        out.push_str(&text_update("contacts:Surname", "Surname", &after.family));
    }
    if differs(&before.person.note, &after.note) {
        out.push_str(&format!(
            r#"<t:SetItemField><t:FieldURI FieldURI="item:Body"/><t:Contact><t:Body BodyType="Text">{}</t:Body></t:Contact></t:SetItemField>"#,
            escape(after.note.trim())
        ));
    }
    out.push_str(&slot_updates("contacts:EmailAddress", "EmailAddresses", &email_plan(&before.email_slots, &after.emails)?));
    out.push_str(&slot_updates("contacts:PhoneNumber", "PhoneNumbers", &phone_plan(&before.phone_slots, &after.phones)?));
    Ok(out)
}

/// A whole new contact, its elements in the order the schema wants them.
fn new_contact_xml(person: &Person, marker: &str) -> Result<String> {
    if !person.is_useful() {
        bail!("a contact needs a name or an email address");
    }
    let emails = email_plan(&[], &person.emails)?;
    let phones = phone_plan(&[], &person.phones)?;
    let field = |element: &str, value: &str| {
        let value = value.trim();
        if value.is_empty() {
            String::new()
        } else {
            format!("<t:{element}>{}</t:{element}>", escape(value))
        }
    };
    let mut xml = String::new();
    if !person.note.trim().is_empty() {
        xml.push_str(&format!(r#"<t:Body BodyType="Text">{}</t:Body>"#, escape(person.note.trim())));
    }
    xml.push_str(&format!("<t:ExtendedProperty>{MARKER}<t:Value>{}</t:Value></t:ExtendedProperty>", escape(marker)));
    xml.push_str(&field("FileAs", &person.name));
    xml.push_str(&field("DisplayName", &person.name));
    xml.push_str(&field("GivenName", &person.given));
    xml.push_str(&field("CompanyName", &person.organisation));
    xml.push_str(&entries_xml("EmailAddresses", &emails));
    xml.push_str(&entries_xml("PhoneNumbers", &phones));
    xml.push_str(&field("Surname", &person.family));
    Ok(format!("<t:Contact>{xml}</t:Contact>"))
}

impl EwsClient {
    /// A contact folder: the Contacts folder itself (`folder` empty), or one
    /// under it by id.
    fn folder_xml(&self, folder: &str) -> String {
        if folder.is_empty() {
            soap::distinguished("contacts", &self.config.target_mailbox)
        } else {
            format!(r#"<t:FolderId Id="{}"/>"#, escape(folder))
        }
    }

    /// The contact folders under the Contacts folder, at any depth. All or
    /// nothing: a refusal fails the listing, so a folder is never taken for
    /// gone because a page went missing.
    pub fn contact_folders(&self) -> Result<Vec<ContactFolder>> {
        let mut folders: Vec<Node> = Vec::new();
        let mut offset = 0usize;
        loop {
            let document = self.call_raw(&format!(
                r#"<m:FindFolder Traversal="Deep"><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="folder:DisplayName"/><t:FieldURI FieldURI="folder:FolderClass"/><t:FieldURI FieldURI="folder:ParentFolderId"/>{HIDDEN}</t:AdditionalProperties></m:FolderShape><m:IndexedPageFolderView MaxEntriesReturned="{PAGE}" Offset="{offset}" BasePoint="Beginning"/><m:ParentFolderIds>{}</m:ParentFolderIds></m:FindFolder>"#,
                self.folder_xml("")
            ))?;
            let message = soap::single(&document, "FindFolder").context("FindFolder contacts")?;
            let root = message.child("RootFolder").context("the contact folder listing has no root folder")?;
            let listed = root.child("Folders").map(|list| list.children.len()).unwrap_or(0);
            folders.extend(root.child("Folders").into_iter().flat_map(|list| list.children.iter().cloned()));
            if root.attr("IncludesLastItemInRange") != Some("false") {
                break;
            }
            if listed == 0 {
                bail!("the contact folder listing stopped giving folders before its end");
            }
            offset += listed;
        }
        Ok(contact_folders_of(&folders))
    }

    /// The item ids in a contact folder matching `restriction` (all of them
    /// when empty), page by page.
    fn contact_ids(&self, folder: &str, restriction: &str) -> Result<Vec<(String, String)>> {
        let mut ids = Vec::new();
        let mut offset = 0usize;
        loop {
            let document = self.call_raw(&format!(
                r#"<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="{PAGE}" Offset="{offset}" BasePoint="Beginning"/>{restriction}<m:ParentFolderIds>{}</m:ParentFolderIds></m:FindItem>"#,
                self.folder_xml(folder)
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

    /// Items by id, with all their properties (the body as text, and our id
    /// on a contact made here), in batches. An item gone between the listing
    /// and this read is left out; any other refusal fails the read, so a
    /// book is never replaced by part of itself.
    fn items(&self, ids: &[String]) -> Result<Vec<Node>> {
        let mut out = Vec::new();
        for batch in ids.chunks(BATCH) {
            let wanted: String = batch.iter().map(|id| soap::item_id(id, None)).collect();
            let document = self.call_raw(&format!(
                "<m:GetItem><m:ItemShape><t:BaseShape>AllProperties</t:BaseShape><t:BodyType>Text</t:BodyType><t:AdditionalProperties>{MARKER}</t:AdditionalProperties></m:ItemShape><m:ItemIds>{wanted}</m:ItemIds></m:GetItem>"
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

    /// A whole contact folder (`folder` empty for the Contacts folder): its
    /// contacts and its distribution lists.
    pub fn read_book(&self, folder: &str) -> Result<Book> {
        let ids: Vec<String> = self
            .contact_ids(folder, "")?
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

    /// One contact as the server holds it now; `None` when it is gone.
    pub fn read_contact(&self, id: &str) -> Result<Option<Contact>> {
        Ok(self.items(&[id.to_string()])?.iter().find(|item| item.name == "Contact").and_then(contact))
    }

    /// Creates a list in a contact folder.
    pub fn create_list(&self, folder: &str, name: &str, members: &[NewMember]) -> Result<(String, String)> {
        let members: String = members.iter().map(member_xml).collect();
        let members = if members.is_empty() { String::new() } else { format!("<t:Members>{members}</t:Members>") };
        let document = self.call_raw(&format!(
            "<m:CreateItem><m:SavedItemFolderId>{}</m:SavedItemFolderId><m:Items><t:DistributionList><t:DisplayName>{}</t:DisplayName>{members}</t:DistributionList></m:Items></m:CreateItem>",
            self.folder_xml(folder),
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
        self.update_item(id, read_at, &updates, "DistributionList")
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
        self.delete_item(id, read_at)
    }

    /// Creates a contact in a contact folder with our id `marker` on it.
    ///
    /// Fails when nothing was created: the contact cannot be written (see
    /// [`contact_changes`]) or the server refused it. An answer that was lost
    /// or could not be read is [`Created::Unknown`]: the contact may be there,
    /// and `marker` finds it.
    pub fn create_contact(&self, folder: &str, person: &Person, marker: &str) -> Result<Created> {
        let contact = new_contact_xml(person, marker)?;
        let document = match self.call_raw(&format!(
            "<m:CreateItem><m:SavedItemFolderId>{}</m:SavedItemFolderId><m:Items>{contact}</m:Items></m:CreateItem>",
            self.folder_xml(folder)
        )) {
            Ok(document) => document,
            Err(error) => return Ok(Created::Unknown(error)),
        };
        // The server's verdict on the item is a refusal: nothing was created.
        // An answer that cannot be read as one says nothing either way.
        let message = match soap::single(&document, "CreateItem") {
            Ok(message) => message,
            Err(error) if soap::error_code(&error).is_some() => return Err(error.context("CreateItem contact")),
            Err(error) => return Ok(Created::Unknown(error)),
        };
        match message.path(&["Items", "Contact", "ItemId"]).and_then(|id| id.attr("Id").map(|key| (key, id))) {
            Some((id, item)) => Ok(Created::Made {
                id: id.to_string(),
                change_key: item.attr("ChangeKey").unwrap_or_default().to_string(),
            }),
            None => Ok(Created::Unknown(anyhow::anyhow!("Exchange did not say which contact it created"))),
        }
    }

    /// The contact of `folder` created here with our id `marker`, if the
    /// server has it.
    pub fn find_marked_contact(&self, folder: &str, marker: &str) -> Result<Option<Contact>> {
        let ids: Vec<String> = self
            .contact_ids(
                folder,
                &format!(
                    r#"<m:Restriction><t:IsEqualTo>{MARKER}<t:FieldURIOrConstant><t:Constant Value="{}"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>"#,
                    escape(marker)
                ),
            )?
            .into_iter()
            .map(|(_, id)| id)
            .collect();
        Ok(self
            .items(&ids)?
            .iter()
            .filter(|item| item.name == "Contact")
            .filter_map(contact)
            .find(|contact| contact.marker.as_deref() == Some(marker)))
    }

    /// Writes what changed from `before` (the contact as read at its change
    /// key) to `after`, never over a change made since (`NeverOverwrite`).
    pub fn update_contact(&self, before: &Contact, after: &Person) -> Result<ListWrite> {
        let (id, read_at) = (before.person.uid.as_str(), before.change_key.as_str());
        // Never written blind (ADR-0012).
        if read_at.is_empty() {
            return Ok(ListWrite::Conflict);
        }
        let updates = contact_changes(before, after)?;
        if updates.is_empty() {
            return Ok(ListWrite::Saved { id: id.to_string(), change_key: read_at.to_string() });
        }
        self.update_item(id, read_at, &updates, "Contact")
    }

    /// Deletes a contact to Deleted Items if it is still as it was read.
    pub fn delete_contact(&self, id: &str, read_at: &str) -> Result<ListWrite> {
        if read_at.is_empty() {
            return Ok(ListWrite::Conflict);
        }
        match self.read_contact(id)? {
            None => return Ok(ListWrite::Saved { id: id.to_string(), change_key: String::new() }),
            Some(current) if current.change_key != read_at => return Ok(ListWrite::Conflict),
            Some(_) => {}
        }
        self.delete_item(id, read_at)
    }

    fn update_item(&self, id: &str, read_at: &str, updates: &str, kind: &str) -> Result<ListWrite> {
        let document = self.call_raw(&format!(
            r#"<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="NeverOverwrite"><m:ItemChanges><t:ItemChange>{}<t:Updates>{updates}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>"#,
            soap::item_id(id, Some(read_at))
        ))?;
        written(&document, "UpdateItem", kind, id)
    }

    fn delete_item(&self, id: &str, read_at: &str) -> Result<ListWrite> {
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
