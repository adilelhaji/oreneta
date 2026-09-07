use super::person::*;

fn one(card: &str) -> Person {
    let people = people_from_vcards(card.as_bytes());
    people.into_iter().next().unwrap_or_default()
}

fn wrap(body: &str) -> String {
    format!("BEGIN:VCARD\nVERSION:3.0\n{body}\nEND:VCARD\n")
}

#[test]
fn reads_the_ordinary_card() {
    let person = one(&wrap("UID:abc-123\nFN:Ana Prat\nEMAIL:Ana@Example.com\nORG:Hospital;Cardiology"));
    assert_eq!(person.uid, "abc-123");
    assert_eq!(person.name, "Ana Prat");
    assert_eq!(person.organisation, "Hospital");
    assert_eq!(person.emails[0].addr, "ana@example.com");
}

#[test]
fn a_person_may_have_several_addresses_which_is_the_whole_point() {
    let person = one(&wrap(
        "FN:Ana\nEMAIL;TYPE=work:ana@work.com\nEMAIL;TYPE=home:ana@home.com",
    ));
    assert_eq!(person.emails.len(), 2);
    assert_eq!(person.emails[0].label, "work");
    assert_eq!(person.emails[1].label, "home");
}

#[test]
fn the_same_address_twice_is_still_one_way_to_reach_them() {
    let person = one(&wrap("FN:Ana\nEMAIL;TYPE=work:ana@x.com\nEMAIL;TYPE=home:ANA@X.com"));
    assert_eq!(person.emails.len(), 1);
}

#[test]
fn builds_a_name_from_the_structured_field_when_there_is_no_full_one() {
    let person = one(&wrap("N:Prat;Ana;Maria;Dra.;PhD\nEMAIL:ana@x.com"));
    assert_eq!(person.name, "Dra. Ana Maria Prat PhD");
}

#[test]
fn an_escaped_semicolon_in_a_surname_is_not_a_separator() {
    let person = one(&wrap(r"N:Prat\; Roca;Ana;;;"));
    assert_eq!(person.name, "Ana Prat; Roca");
}

#[test]
fn the_full_name_wins_over_the_structured_one() {
    let person = one(&wrap("N:Prat;Ana;;;\nFN:Ana Prat i Roca"));
    assert_eq!(person.name, "Ana Prat i Roca");
}

#[test]
fn a_person_with_no_name_at_all_is_called_by_their_address() {
    let person = one(&wrap("EMAIL:ana@example.com"));
    assert_eq!(person.name, "ana@example.com");
}

#[test]
fn a_card_with_neither_a_name_nor_an_address_is_not_kept() {
    assert!(people_from_vcards(wrap("NOTE:nothing here").as_bytes()).is_empty());
}

#[test]
fn an_apple_label_wins_over_the_generic_type_and_loses_its_wrapper() {
    let person = one(&wrap(
        "FN:Ana\nitem1.EMAIL;TYPE=INTERNET:ana@x.com\nitem1.X-ABLabel:_$!<Work>!$_",
    ));
    assert_eq!(person.emails[0].label, "Work");
}

#[test]
fn a_custom_apple_label_comes_through_as_written() {
    let person = one(&wrap("FN:Ana\nitem1.EMAIL:ana@x.com\nitem1.X-ABLabel:Summer house"));
    assert_eq!(person.emails[0].label, "Summer house");
}

#[test]
fn how_to_use_an_address_is_not_what_it_is_for() {
    let person = one(&wrap("FN:Ana\nEMAIL;TYPE=INTERNET,PREF,WORK:ana@x.com"));
    assert_eq!(person.emails[0].label, "work");
}

#[test]
fn phone_numbers_come_through_with_their_labels() {
    let person = one(&wrap("FN:Ana\nTEL;TYPE=CELL:+34 600 00 00 00\nTEL;TYPE=WORK,VOICE:+34 93 000"));
    assert_eq!(person.phones.len(), 2);
    assert_eq!(person.phones[0].label, "cell");
    assert_eq!(person.phones[1].label, "work");
}

#[test]
fn a_photo_carried_as_base64_becomes_bytes() {
    // "GIF89a", enough to be recognisably a file rather than noise.
    let person = one(&wrap("FN:Ana\nEMAIL:a@x.com\nPHOTO;ENCODING=b;TYPE=GIF:R0lGODlhAQ=="));
    match person.photo {
        Some(Photo::Bytes { mime, data }) => {
            assert_eq!(mime, "image/gif");
            assert_eq!(&data[..3], b"GIF");
        }
        other => panic!("expected bytes, got {other:?}"),
    }
}

#[test]
fn a_photo_carried_as_a_data_uri_becomes_bytes_too() {
    let person = one(&wrap("FN:Ana\nEMAIL:a@x.com\nPHOTO:data:image/png;base64,iVBORw0KGgo="));
    match person.photo {
        Some(Photo::Bytes { mime, data }) => {
            assert_eq!(mime, "image/png");
            assert_eq!(&data[1..4], b"PNG");
        }
        other => panic!("expected bytes, got {other:?}"),
    }
}

#[test]
fn a_photo_that_is_a_link_stays_a_link() {
    let person = one(&wrap("FN:Ana\nEMAIL:a@x.com\nPHOTO;VALUE=URI:https://example.com/a.jpg"));
    assert_eq!(person.photo, Some(Photo::Url("https://example.com/a.jpg".into())));
}

#[test]
fn a_photo_pointing_at_this_machine_is_refused() {
    // A card is a file from somewhere else. `file:` in one is either a mistake
    // or an attempt to have the app read a local path on the sender's behalf.
    for value in ["file:///etc/passwd", "/home/someone/photo.jpg"] {
        let person = one(&wrap(&format!("FN:Ana\nEMAIL:a@x.com\nPHOTO;VALUE=URI:{value}")));
        assert_eq!(person.photo, None, "{value}");
    }
}

#[test]
fn a_photo_that_cannot_be_decoded_does_not_cost_the_person() {
    let person = one(&wrap("FN:Ana\nEMAIL:ana@x.com\nPHOTO;ENCODING=b:!!!not base64!!!"));
    assert_eq!(person.photo, None);
    assert_eq!(person.name, "Ana");
    assert_eq!(person.emails.len(), 1);
}

#[test]
fn a_whole_book_comes_through_at_once() {
    let book = format!("{}{}", wrap("FN:Ana\nEMAIL:ana@x.com"), wrap("FN:Marc\nEMAIL:marc@x.com"));
    let people = people_from_vcards(book.as_bytes());
    assert_eq!(people.len(), 2);
    assert_eq!(people[1].name, "Marc");
}

#[test]
fn one_unusable_card_does_not_take_the_others_with_it() {
    let book = format!(
        "{}{}{}",
        wrap("FN:Ana\nEMAIL:ana@x.com"),
        wrap("NOTE:nothing"),
        wrap("FN:Marc\nEMAIL:marc@x.com")
    );
    assert_eq!(people_from_vcards(book.as_bytes()).len(), 2);
}

#[test]
fn a_quoted_printable_name_from_an_old_exporter_is_read() {
    let card = "BEGIN:VCARD\nVERSION:2.1\nN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Prat;Andr=C3=A9;;;\nEMAIL;INTERNET:a@x.com\nEND:VCARD";
    let person = one(card);
    assert_eq!(person.name, "André Prat");
}
