//! Online meetings on events (#109, ADR-0034).
//!
//! A meeting is bound to its event: read from what the server says (Google's
//! conference data) or, for any calendar, from a meeting address in the
//! event's location or notes. Creating one is only ever the person's action,
//! on the event they are saving, and only where the account can do it without
//! a new registration: Google Meet on a Google calendar.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Meeting {
    /// `meet`, `zoom`, `teams`, `webex`, `jitsi`, `gotomeeting`, `whereby`.
    pub provider: String,
    pub url: String,
}

/// The services recognised in event text, by the start of their join address.
const KNOWN: &[(&str, &[&str])] = &[
    ("meet", &["https://meet.google.com/"]),
    ("zoom", &["https://zoom.us/j/", "https://zoom.us/my/", ".zoom.us/j/", ".zoom.us/my/", ".zoom.us/w/"]),
    (
        "teams",
        &["https://teams.microsoft.com/l/meetup-join/", "https://teams.microsoft.com/meet/", "https://teams.live.com/meet/"],
    ),
    ("webex", &[".webex.com/meet/", ".webex.com/join/", ".webex.com/wbxmjs/", ".webex.com/"]),
    ("jitsi", &["https://meet.jit.si/"]),
    ("gotomeeting", &["https://meet.goto.com/", "https://global.gotomeeting.com/join/", "https://gotomeet.me/"]),
    ("whereby", &["https://whereby.com/"]),
];

/// The first meeting address in some text, if it names a known service.
pub fn detect(text: &str) -> Option<Meeting> {
    for word in text.split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '(' | ')')) {
        let word = word.trim_end_matches(['.', ',', ';']);
        if !word.starts_with("https://") {
            continue;
        }
        let Ok(url) = url::Url::parse(word) else { continue };
        let host = url.host_str().unwrap_or_default();
        let address = format!("https://{host}{}", url.path());
        for (provider, starts) in KNOWN {
            let hit = starts.iter().any(|start| {
                if let Some(suffix) = start.strip_prefix('.') {
                    // A subdomain of the service: `acme.zoom.us/j/…`.
                    let (domain, path) = suffix.split_once('/').unwrap_or((suffix, ""));
                    host.ends_with(&format!(".{domain}")) && url.path().starts_with(&format!("/{path}"))
                        && url.path().len() > path.len() + 1
                } else {
                    address.starts_with(start) && address.len() > start.len()
                }
            });
            if hit {
                return Some(Meeting { provider: provider.to_string(), url: word.to_string() });
            }
        }
    }
    None
}

/// The meeting on an event: what the server said, else what its text holds.
pub fn of(event: &super::Event) -> Option<Meeting> {
    event.meeting.clone().or_else(|| {
        detect(event.location.as_deref().unwrap_or_default()).or_else(|| detect(&event.description))
    })
}

/// The meetings this build can create, per kind of calendar.
pub fn can_create(provider: &str, calendar_kind: &str) -> bool {
    provider == "meet" && calendar_kind == "google"
}

/// The same request for the same event always asks for the same meeting, so
/// a save repeated after a lost answer never makes a second one.
pub fn request_id(calendar_id: &str, event_key: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("oreneta-meet\0{calendar_id}\0{event_key}"));
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeting_addresses_are_recognised_by_service_and_nothing_else() {
        let cases = [
            ("Join: https://meet.google.com/abc-defg-hij", Some("meet")),
            ("https://us02web.zoom.us/j/8123456789?pwd=xyz.", Some("zoom")),
            ("<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d>", Some("teams")),
            ("https://acme.webex.com/meet/ana", Some("webex")),
            ("(https://meet.jit.si/OrenetaWeekly)", Some("jitsi")),
            ("https://meet.goto.com/123456789", Some("gotomeeting")),
            ("https://zoom.us/", None),
            ("https://meet.google.com.evil.test/abc", None),
            ("https://evilzoom.us/j/1", None),
            ("http://meet.google.com/abc-defg-hij", None),
            ("Room 4, second floor", None),
        ];
        for (text, want) in cases {
            assert_eq!(detect(text).map(|m| m.provider), want.map(String::from), "{text}");
        }
        assert_eq!(
            detect("Zoom: https://us02web.zoom.us/j/8123456789?pwd=xyz, then lunch").unwrap().url,
            "https://us02web.zoom.us/j/8123456789?pwd=xyz"
        );
    }

    #[test]
    fn only_meet_on_a_google_calendar_can_be_created_here() {
        assert!(can_create("meet", "google"));
        assert!(!can_create("meet", "exchange"));
        assert!(!can_create("zoom", "google"));
        assert!(!can_create("teams", "exchange"));
    }

    #[test]
    fn the_same_event_always_asks_for_the_same_meeting() {
        assert_eq!(request_id("primary", "ev1"), request_id("primary", "ev1"));
        assert_ne!(request_id("primary", "ev1"), request_id("primary", "ev2"));
        assert_eq!(request_id("primary", "ev1").len(), 32);
    }
}
