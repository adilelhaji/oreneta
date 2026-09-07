use super::mime::*;

const BUILT: &[u8] = b"From: Ana <ana@example.com>\r\n\
To: Marc <marc@example.com>\r\n\
Subject: Figures\r\n\
Message-ID: <abc@example.com>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
The figures are 12 and 34.\r\n";

#[test]
fn the_message_headers_stay_outside_the_part_that_gets_signed() {
    let split = split_for_signing(BUILT).unwrap();
    assert!(split.message_headers.contains("From: Ana"));
    assert!(split.message_headers.contains("Subject: Figures"));
    assert!(split.message_headers.contains("Message-ID:"));
    // Signing these would make every recipient's copy unverifiable, because
    // theirs carries headers the sender's did not.
    assert!(!String::from_utf8_lossy(&split.entity).contains("From: Ana"));
}

#[test]
fn the_content_headers_go_inside_it_because_the_signature_covers_them() {
    let split = split_for_signing(BUILT).unwrap();
    let entity = String::from_utf8_lossy(&split.entity);
    assert!(entity.contains("Content-Type: text/plain; charset=utf-8"));
    assert!(entity.contains("Content-Transfer-Encoding: quoted-printable"));
    assert!(entity.contains("The figures are 12 and 34."));
}

#[test]
fn mime_version_belongs_to_the_message_and_not_to_the_part() {
    let split = split_for_signing(BUILT).unwrap();
    assert!(split.message_headers.contains("MIME-Version"));
    assert!(!String::from_utf8_lossy(&split.entity).contains("MIME-Version"));
}

#[test]
fn a_folded_header_is_not_torn_in_half() {
    // A long Content-Type with parameters is routinely folded, and half of it
    // landing on the wrong side would corrupt both sides.
    let folded: &[u8] = b"From: ana@example.com\r\n\
Content-Type: multipart/mixed;\r\n\tboundary=\"xyz\";\r\n\tcharset=utf-8\r\n\
Subject: Hi\r\n\
\r\n\
body\r\n";
    let split = split_for_signing(folded).unwrap();
    let entity = String::from_utf8_lossy(&split.entity);
    assert!(entity.contains("boundary=\"xyz\""));
    assert!(entity.contains("charset=utf-8"));
    assert!(!split.message_headers.contains("boundary"));
    // And the header after the folded one is read as its own field again.
    assert!(split.message_headers.contains("Subject: Hi"));
}

#[test]
fn the_body_comes_through_byte_for_byte() {
    let split = split_for_signing(BUILT).unwrap();
    let entity = split.entity;
    let body_start = entity.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    assert_eq!(&entity[body_start..], b"The figures are 12 and 34.\r\n");
}

#[test]
fn a_message_with_no_header_block_at_all_is_refused() {
    assert!(split_for_signing(b"no headers here").is_none());
}

#[test]
fn a_signed_message_reads_back_as_a_signed_message() {
    let split = split_for_signing(BUILT).unwrap();
    let assembled = build_signed(&split.message_headers, &split.entity, b"SIGNATURE", "sha256");
    let parsed = mailparse::parse_mail(&assembled).unwrap();
    assert_eq!(
        super::detect::protection_of(&parsed),
        super::detect::Protection::PgpSigned
    );
    // And the part that was signed is the first one, unchanged.
    let (content, signature) = super::detect::signed_parts(&parsed).unwrap();
    assert_eq!(content.raw_bytes, split.entity.as_slice());
    assert!(signature.get_body().unwrap().contains("SIGNATURE"));
}

#[test]
fn the_digest_is_named_the_way_the_format_requires() {
    let split = split_for_signing(BUILT).unwrap();
    let assembled = build_signed(&split.message_headers, &split.entity, b"SIG", "sha512");
    assert!(String::from_utf8_lossy(&assembled).contains("micalg=\"pgp-sha512\""));
}

#[test]
fn an_encrypted_message_reads_back_as_an_encrypted_message() {
    let split = split_for_signing(BUILT).unwrap();
    let assembled = build_encrypted(&split.message_headers, b"CIPHERTEXT");
    let parsed = mailparse::parse_mail(&assembled).unwrap();
    assert_eq!(
        super::detect::protection_of(&parsed),
        super::detect::Protection::PgpEncrypted
    );
    let body = super::detect::pgp_encrypted_parts(&parsed).unwrap();
    assert!(body.get_body().unwrap().contains("CIPHERTEXT"));
    // The subject travels in the clear — that is what this format does — and
    // the recipients must still be there for it to be delivered at all.
    assert!(String::from_utf8_lossy(&assembled).contains("To: Marc"));
}

#[test]
fn two_messages_do_not_share_a_boundary() {
    let split = split_for_signing(BUILT).unwrap();
    let one = String::from_utf8(build_encrypted(&split.message_headers, b"A")).unwrap();
    let two = String::from_utf8(build_encrypted(&split.message_headers, b"B")).unwrap();
    let boundary_of = |text: &str| {
        text.split("boundary=\"").nth(1).unwrap().split('"').next().unwrap().to_string()
    };
    assert_ne!(boundary_of(&one), boundary_of(&two));
}
