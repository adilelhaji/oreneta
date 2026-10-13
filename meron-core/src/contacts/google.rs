//! Reading a Google account's contacts through the People API.
//!
//! The same account whose mail is already here, using the token it already
//! holds — so nothing is asked of the reader that they have not answered once,
//! except the one new permission: the OAuth scope for contacts, which an
//! account connected before this existed will not have. That case is named
//! rather than left as an HTTP status.

use anyhow::{Context, Result};
use serde::Deserialize;

use super::person::{EmailAddress, Person, PhoneNumber, Photo};

const API: &str = "https://people.googleapis.com/v1/people/me/connections";
const FIELDS: &str = "names,emailAddresses,organizations,phoneNumbers,photos,biographies,memberships";
/// The account's contact groups ("labels"). Readable with the
/// `contacts.readonly` scope the account already asks for (ADR-0052).
const GROUPS_API: &str = "https://people.googleapis.com/v1/contactGroups";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionsPage {
    #[serde(default)]
    connections: Vec<GooglePerson>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GooglePerson {
    #[serde(default)]
    resource_name: String,
    #[serde(default)]
    names: Vec<Name>,
    #[serde(default)]
    email_addresses: Vec<Typed>,
    #[serde(default)]
    phone_numbers: Vec<Typed>,
    #[serde(default)]
    organizations: Vec<Organization>,
    #[serde(default)]
    photos: Vec<GooglePhoto>,
    #[serde(default)]
    biographies: Vec<Biography>,
    #[serde(default)]
    memberships: Vec<Membership>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Membership {
    #[serde(default)]
    contact_group_membership: Option<GroupMembership>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GroupMembership {
    #[serde(default)]
    contact_group_resource_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupsPage {
    #[serde(default)]
    contact_groups: Vec<GoogleGroupEntry>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GoogleGroupEntry {
    #[serde(default)]
    resource_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    formatted_name: String,
    #[serde(default)]
    group_type: String,
}

/// One of the account's own contact groups, with its members' resource names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleGroup {
    pub resource_name: String,
    pub name: String,
    pub members: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Name {
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    given_name: String,
    #[serde(default)]
    family_name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Typed {
    #[serde(default)]
    value: String,
    /// Google's own wording for the label — "work", "home", or whatever the
    /// person typed. `type` is the raw one; `formattedType` the display one.
    #[serde(default)]
    formatted_type: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Organization {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GooglePhoto {
    #[serde(default)]
    url: String,
    /// True for the silhouette Google shows when there is no picture. Not a
    /// photo of anyone, so not kept as one.
    #[serde(default)]
    default: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Biography {
    #[serde(default)]
    value: String,
}

/// Read one page of the API's answer as people.
///
/// Public so the shape can be tested against captured responses without a
/// token; the network part is a loop around this.
pub fn people_from_page(json: &str) -> Result<(Vec<Person>, Option<String>)> {
    let (people, _, next) = page_with_memberships(json)?;
    Ok((people, next))
}

/// One page of people, with which group each belongs to as
/// `(person resource name, group resource name)` pairs.
pub fn page_with_memberships(json: &str) -> Result<(Vec<Person>, Vec<(String, String)>, Option<String>)> {
    let page: ConnectionsPage = serde_json::from_str(json).context("read People API response")?;
    let mut memberships = Vec::new();
    let mut people = Vec::new();
    for entry in page.connections {
        let uid = entry.resource_name.trim().to_string();
        for membership in &entry.memberships {
            if let Some(group) = &membership.contact_group_membership {
                if !group.contact_group_resource_name.is_empty() && !uid.is_empty() {
                    memberships.push((uid.clone(), group.contact_group_resource_name.clone()));
                }
            }
        }
        let person = person_from_google(entry);
        if person.is_useful() {
            people.push(person);
        }
    }
    Ok((people, memberships, page.next_page_token.filter(|token| !token.is_empty())))
}

/// One page of the account's groups: only the ones the person made. Google's
/// own ("My Contacts", "Starred", …) are views of the book, not groups
/// somebody chose to keep.
pub fn groups_from_page(json: &str) -> Result<(Vec<GoogleGroup>, Option<String>)> {
    let page: GroupsPage = serde_json::from_str(json).context("read People API contact groups")?;
    let groups = page
        .contact_groups
        .into_iter()
        .filter(|group| group.group_type == "USER_CONTACT_GROUP" && !group.resource_name.is_empty())
        .map(|group| GoogleGroup {
            resource_name: group.resource_name,
            name: if group.formatted_name.trim().is_empty() { group.name } else { group.formatted_name }
                .trim()
                .to_string(),
            members: Vec::new(),
        })
        .collect();
    Ok((groups, page.next_page_token.filter(|token| !token.is_empty())))
}

/// Puts each person in the groups the memberships name. A membership of a
/// group that is not one of the person's own is dropped.
pub fn assign_members(groups: &mut [GoogleGroup], memberships: &[(String, String)]) {
    for (person, group) in memberships {
        if let Some(found) = groups.iter_mut().find(|candidate| &candidate.resource_name == group) {
            if !found.members.contains(person) {
                found.members.push(person.clone());
            }
        }
    }
}

fn person_from_google(entry: GooglePerson) -> Person {
    let mut seen: Vec<String> = Vec::new();
    let emails = entry
        .email_addresses
        .into_iter()
        .filter_map(|email| {
            let addr = email.value.trim().to_lowercase();
            if addr.is_empty() || seen.contains(&addr) {
                return None;
            }
            seen.push(addr.clone());
            Some(EmailAddress {
                addr,
                label: email.formatted_type.trim().to_lowercase(),
            })
        })
        .collect::<Vec<_>>();

    let first_name = entry.names.first();
    let given = first_name.map(|name| name.given_name.trim().to_string()).unwrap_or_default();
    let family = first_name.map(|name| name.family_name.trim().to_string()).unwrap_or_default();
    let mut person = Person {
        uid: entry.resource_name.trim().to_string(),
        given,
        family,
        name: entry
            .names
            .first()
            .map(|name| name.display_name.trim().to_string())
            .unwrap_or_default(),
        organisation: entry
            .organizations
            .first()
            .map(|org| org.name.trim().to_string())
            .unwrap_or_default(),
        note: entry
            .biographies
            .first()
            .map(|bio| bio.value.trim().to_string())
            .unwrap_or_default(),
        emails,
        phones: entry
            .phone_numbers
            .into_iter()
            .filter(|phone| !phone.value.trim().is_empty())
            .map(|phone| PhoneNumber {
                number: phone.value.trim().to_string(),
                label: phone.formatted_type.trim().to_lowercase(),
            })
            .collect(),
        photo: entry
            .photos
            .into_iter()
            .find(|photo| !photo.default && photo.url.starts_with("https://"))
            .map(|photo| Photo::Url(photo.url)),
    };
    if person.name.is_empty() {
        if let Some(first) = person.emails.first() {
            person.name = first.addr.clone();
        }
    }
    person
}

/// What to tell the reader about a refused call.
///
/// The refusal worth naming is a token that predates the contacts permission:
/// the account works, the mail works, and nothing on screen says why the
/// contacts do not. Reconnecting is the fix, so the message says so.
pub fn explain(status: u16, body: &str) -> String {
    #[derive(Deserialize)]
    struct Envelope {
        error: Option<ErrorBody>,
    }
    #[derive(Deserialize)]
    struct ErrorBody {
        message: Option<String>,
    }
    let message = serde_json::from_str::<Envelope>(body)
        .ok()
        .and_then(|envelope| envelope.error.and_then(|error| error.message))
        .unwrap_or_else(|| body.chars().take(200).collect());
    let needs_consent = (status == 403 && message.to_lowercase().contains("scope"))
        || body.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    if needs_consent {
        return "this account has not granted access to its contacts yet — reconnect it \
                to sign in again and allow contacts"
            .to_string();
    }
    format!("Google People answered {status}: {message}")
}

/// Every contact the account holds. Blocking; callers wrap in `spawn_blocking`.
pub fn fetch_connections(token: &str) -> Result<Vec<Person>> {
    fetch_connections_and_groups(token).map(|(people, _)| people)
}

/// Every contact, and the account's own groups with their members.
///
/// The groups are `None` when they could not be read — the people are still
/// worth having, and the caller keeps the groups it had rather than emptying
/// them.
pub fn fetch_connections_and_groups(token: &str) -> Result<(Vec<Person>, Option<Vec<GoogleGroup>>)> {
    let agent = crate::proxy::agent()?;
    let authorization = format!("Bearer {token}");
    let mut people = Vec::new();
    let mut memberships: Vec<(String, String)> = Vec::new();
    let mut page_token: Option<String> = None;

    // Bounded, so a server that kept handing out page tokens could not keep
    // this going forever. A thousand pages is a million contacts.
    for _ in 0..1000 {
        let mut url = format!("{API}?personFields={FIELDS}&pageSize=1000");
        if let Some(token) = &page_token {
            url.push_str("&pageToken=");
            url.push_str(token);
        }
        let mut response = agent
            .get(&url)
            .header("Authorization", &authorization)
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .call()
            .with_context(|| format!("GET {url}"))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().context("read People API response")?;
        if !(200..300).contains(&status) {
            anyhow::bail!("{}", explain(status, &text));
        }
        let (page, members, next) = page_with_memberships(&text)?;
        people.extend(page);
        memberships.extend(members);
        match next {
            Some(next) => page_token = Some(next),
            None => break,
        }
    }
    let groups = fetch_groups(&agent, &authorization).ok().map(|mut groups| {
        assign_members(&mut groups, &memberships);
        groups
    });
    Ok((people, groups))
}

fn fetch_groups(agent: &ureq::Agent, authorization: &str) -> Result<Vec<GoogleGroup>> {
    let mut groups = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..100 {
        let mut url = format!("{GROUPS_API}?pageSize=1000&groupFields=name,groupType");
        if let Some(token) = &page_token {
            url.push_str("&pageToken=");
            url.push_str(token);
        }
        let mut response = agent
            .get(&url)
            .header("Authorization", authorization)
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .call()
            .with_context(|| format!("GET {url}"))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().context("read People API contact groups")?;
        if !(200..300).contains(&status) {
            anyhow::bail!("{}", explain(status, &text));
        }
        let (page, next) = groups_from_page(&text)?;
        groups.extend(page);
        match next {
            Some(next) => page_token = Some(next),
            None => break,
        }
    }
    Ok(groups)
}
