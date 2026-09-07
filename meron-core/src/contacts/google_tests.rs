use super::google::*;
use super::person::Photo;

const PAGE: &str = r#"{
  "connections": [
    {
      "resourceName": "people/c123",
      "names": [{"displayName": "Ana Prat"}],
      "emailAddresses": [
        {"value": "Ana@Hospital.cat", "type": "work", "formattedType": "Work"},
        {"value": "ana@casa.cat", "formattedType": "Home"},
        {"value": "ana@hospital.cat", "formattedType": "Other"}
      ],
      "phoneNumbers": [{"value": "+34 600 000 000", "formattedType": "Mobile"}],
      "organizations": [{"name": "Hospital de Mataró", "title": "Cardiologist"}],
      "photos": [{"url": "https://lh3.googleusercontent.com/a/photo=s100", "default": false}],
      "biographies": [{"value": "Met at the congress."}]
    },
    {
      "resourceName": "people/c456",
      "emailAddresses": [{"value": "marc@example.com"}],
      "photos": [{"url": "https://lh3.googleusercontent.com/a/default-user=s100", "default": true}]
    },
    {
      "resourceName": "people/c789",
      "names": [{"displayName": ""}]
    }
  ],
  "nextPageToken": "abc",
  "totalPeople": 3
}"#;

#[test]
fn reads_a_page_of_connections() {
    let (people, next) = people_from_page(PAGE).unwrap();
    assert_eq!(next, Some("abc".into()));
    assert_eq!(people.len(), 2);
    let ana = &people[0];
    assert_eq!(ana.uid, "people/c123");
    assert_eq!(ana.name, "Ana Prat");
    assert_eq!(ana.organisation, "Hospital de Mataró");
    assert_eq!(ana.note, "Met at the congress.");
}

#[test]
fn addresses_are_lower_cased_labelled_and_not_repeated() {
    let (people, _) = people_from_page(PAGE).unwrap();
    let ana = &people[0];
    assert_eq!(ana.emails.len(), 2);
    assert_eq!(ana.emails[0].addr, "ana@hospital.cat");
    assert_eq!(ana.emails[0].label, "work");
    assert_eq!(ana.emails[1].label, "home");
}

#[test]
fn a_real_photo_is_kept_and_the_default_silhouette_is_not() {
    let (people, _) = people_from_page(PAGE).unwrap();
    assert!(matches!(&people[0].photo, Some(Photo::Url(url)) if url.contains("googleusercontent")));
    assert_eq!(people[1].photo, None);
}

#[test]
fn somebody_with_no_name_is_called_by_their_address() {
    let (people, _) = people_from_page(PAGE).unwrap();
    assert_eq!(people[1].name, "marc@example.com");
}

#[test]
fn an_entry_with_neither_name_nor_address_is_not_kept() {
    let (people, _) = people_from_page(PAGE).unwrap();
    assert!(people.iter().all(|person| person.uid != "people/c789"));
}

#[test]
fn the_last_page_has_no_next_token() {
    let (people, next) = people_from_page(r#"{"connections": []}"#).unwrap();
    assert!(people.is_empty());
    assert_eq!(next, None);
    let (_, next) = people_from_page(r#"{"connections": [], "nextPageToken": ""}"#).unwrap();
    assert_eq!(next, None);
}

#[test]
fn an_answer_that_is_not_json_is_an_error_and_not_an_empty_book() {
    assert!(people_from_page("<html>Sign in</html>").is_err());
}

#[test]
fn a_token_without_the_contacts_permission_is_told_to_reconnect() {
    let body = r#"{"error": {"code": 403, "message": "Request had insufficient authentication scopes.", "status": "PERMISSION_DENIED"}}"#;
    assert!(explain(403, body).contains("reconnect"));
    let body2 = r#"{"error": {"details": [{"reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}"#;
    assert!(explain(403, body2).contains("reconnect"));
}

#[test]
fn any_other_refusal_says_what_google_said() {
    let body = r#"{"error": {"code": 429, "message": "Quota exceeded."}}"#;
    let text = explain(429, body);
    assert!(text.contains("429"));
    assert!(text.contains("Quota exceeded."));
}
