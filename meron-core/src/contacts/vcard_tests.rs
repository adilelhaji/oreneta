use super::vcard::*;

fn props(input: &str) -> Vec<Property> {
    parse_properties(input.as_bytes())
}

fn value_of(input: &str, name: &str) -> String {
    props(input)
        .into_iter()
        .find(|property| property.name == name)
        .map(|property| property.value)
        .unwrap_or_default()
}

#[test]
fn reads_a_plain_property() {
    let property = &props("FN:Ana Prat")[0];
    assert_eq!(property.name, "FN");
    assert_eq!(property.value, "Ana Prat");
    assert!(property.group.is_empty());
}

#[test]
fn the_name_is_read_in_one_spelling_whatever_the_card_used() {
    assert_eq!(props("fn:Ana")[0].name, "FN");
}

#[test]
fn a_colon_in_the_value_does_not_end_the_name() {
    assert_eq!(value_of("URL:https://example.com/x", "URL"), "https://example.com/x");
}

#[test]
fn a_colon_inside_a_quoted_parameter_does_not_end_the_name_either() {
    let property = &props("TEL;TYPE=\"work:main\":+34 600")[0];
    assert_eq!(property.value, "+34 600");
    assert_eq!(property.param("TYPE"), vec!["work:main"]);
}

#[test]
fn folded_lines_are_joined_without_their_marker() {
    assert_eq!(value_of("NOTE:one \r\n two", "NOTE"), "one two");
    assert_eq!(value_of("NOTE:one\n\tmore", "NOTE"), "onemore");
}

#[test]
fn a_fold_inside_a_character_does_not_break_it() {
    // The two bytes of "é" split across a fold, which is legal and which a
    // parser working in characters would have already ruined.
    let bytes = b"FN:Andr\xc3\r\n \xa9 Prat";
    let parsed = parse_properties(bytes);
    assert_eq!(parsed[0].value, "André Prat");
}

#[test]
fn a_grouped_property_keeps_its_group() {
    let property = &props("item1.EMAIL:ana@example.com")[0];
    assert_eq!(property.group, "item1");
    assert_eq!(property.name, "EMAIL");
}

#[test]
fn escapes_are_undone() {
    assert_eq!(value_of(r"NOTE:one\, two\; three\\ four\nfive", "NOTE"), "one, two; three\\ four\nfive");
}

#[test]
fn a_stray_backslash_keeps_what_it_escaped_and_not_itself() {
    assert_eq!(value_of(r"NOTE:C:\path", "NOTE"), "C:path");
}

#[test]
fn bare_types_are_read_as_types_because_vcard_2_writes_them_that_way() {
    let property = &props("EMAIL;WORK;PREF:ana@example.com")[0];
    assert_eq!(property.types(), vec!["work", "pref"]);
}

#[test]
fn named_types_are_read_too_and_a_comma_separates_them() {
    let property = &props("EMAIL;TYPE=work,pref:ana@example.com")[0];
    assert_eq!(property.types(), vec!["work", "pref"]);
}

#[test]
fn quoted_printable_is_decoded() {
    let card = "FN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Andr=C3=A9";
    assert_eq!(value_of(card, "FN"), "André");
}

#[test]
fn quoted_printable_in_latin_1_is_decoded_as_latin_1() {
    let card = "FN;ENCODING=QUOTED-PRINTABLE;CHARSET=ISO-8859-1:Andr=E9";
    assert_eq!(value_of(card, "FN"), "André");
}

#[test]
fn an_equals_that_is_not_an_escape_survives() {
    let card = "NOTE;ENCODING=QUOTED-PRINTABLE:a=b";
    assert_eq!(value_of(card, "NOTE"), "a=b");
}

#[test]
fn a_line_with_no_colon_is_skipped_rather_than_fatal() {
    let parsed = props("FN:Ana\nrubbish\nEMAIL:ana@example.com");
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[1].name, "EMAIL");
}

#[test]
fn a_card_with_one_bad_byte_still_yields_its_other_properties() {
    let bytes = b"BEGIN:VCARD\nFN:Ana\nNOTE:\xff\xfe\nEMAIL:ana@example.com\nEND:VCARD";
    let cards = split_cards(bytes);
    assert_eq!(cards.len(), 1);
    assert!(cards[0].iter().any(|p| p.name == "EMAIL"));
}

#[test]
fn several_cards_in_one_stream_are_separated() {
    let stream = "BEGIN:VCARD\nFN:Ana\nEND:VCARD\r\nBEGIN:VCARD\nFN:Marc\nEND:VCARD\n";
    let cards = split_cards(stream.as_bytes());
    assert_eq!(cards.len(), 2);
    assert_eq!(cards[1][0].value, "Marc");
}

#[test]
fn the_bounds_are_not_kept_as_properties() {
    let cards = split_cards(b"BEGIN:VCARD\nFN:Ana\nEND:VCARD");
    assert_eq!(cards[0].len(), 1);
}

#[test]
fn a_card_whose_end_never_arrived_is_still_a_card() {
    let cards = split_cards(b"BEGIN:VCARD\nFN:Ana\nEMAIL:ana@example.com");
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].len(), 2);
}

#[test]
fn a_nested_card_does_not_end_the_one_holding_it() {
    let stream = "BEGIN:VCARD\nFN:Ana\nBEGIN:VCARD\nFN:Inner\nEND:VCARD\nEMAIL:ana@example.com\nEND:VCARD";
    let cards = split_cards(stream.as_bytes());
    assert_eq!(cards.len(), 1);
    assert!(cards[0].iter().any(|p| p.name == "EMAIL"));
}

#[test]
fn text_outside_any_card_is_ignored() {
    let cards = split_cards(b"FN:Loose\nBEGIN:VCARD\nFN:Ana\nEND:VCARD");
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0][0].value, "Ana");
}

#[test]
fn a_structured_value_is_kept_as_written_as_well_as_unescaped() {
    let property = &props(r"N:Prat\; Roca;Ana;;;")[0];
    // The convenient form for a single-value property...
    assert_eq!(property.value, "Prat; Roca;Ana;;;");
    // ...and the form a structured reader needs, where the escape still says
    // which semicolons are separators and which are somebody's surname.
    assert_eq!(property.raw, r"N:Prat\; Roca;Ana;;;".split_once(':').unwrap().1);
}

#[test]
fn a_quoted_printable_value_is_the_same_either_way() {
    let property = &props("NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:a=3Bb")[0];
    assert_eq!(property.value, "a;b");
    assert_eq!(property.raw, "a;b");
}
