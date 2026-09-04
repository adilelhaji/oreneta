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
const FIELDS: &str = "names,emailAddresses,organizations,phoneNumbers,photos,biographies";
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
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Name {
    #[serde(default)]
    display_name: String,
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
    let page: ConnectionsPage = serde_json::from_str(json).context("read People API response")?;
    let people = page
        .connections
        .into_iter()
        .map(person_from_google)
        .filter(Person::is_useful)
        .collect();
    Ok((people, page.next_page_token.filter(|token| !token.is_empty())))
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

    let mut person = Person {
        uid: entry.resource_name.trim().to_string(),
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
    let agent = crate::proxy::agent()?;
    let authorization = format!("Bearer {token}");
    let mut people = Vec::new();
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
        let (page, next) = people_from_page(&text)?;
        people.extend(page);
        match next {
            Some(next) => page_token = Some(next),
            None => break,
        }
    }
    Ok(people)
}
