//! Interoperability with independent tools (#49): fixtures made by GnuPG and
//! OpenSSL are read here, and what this writes is read by GnuPG and OpenSSL.
//! See testdata/interop/README.md for how each fixture was made.

use std::io::Write;
use std::process::{Command, Stdio};

use super::{pgp, pkcs12, smime};

const PAU_PUBLIC: &str = include_str!("testdata/interop/pau_public.asc");
const PAU_SECRET: &str = include_str!("testdata/interop/pau_secret.asc");
const OLGA_PUBLIC: &str = include_str!("testdata/interop/olga_public.asc");
const FIXTURE_SECRET: &str = include_str!("testdata/gnupg/fixture_secret.asc");
const SARA_DER: &[u8] = include_bytes!("testdata/interop/sara.der");
const SARA_P12: &[u8] = include_bytes!("testdata/interop/sara.p12");

fn pau() -> sequoia_openpgp::Cert {
    pgp::read_cert(PAU_PUBLIC).unwrap().0
}

fn sara() -> pkcs12::Identity {
    pkcs12::read_pkcs12(SARA_P12, "interop").unwrap()
}

// ---- Reading what GnuPG and OpenSSL wrote -----------------------------------

#[test]
fn a_gnupg_signature_checks_out_and_names_its_signer() {
    let signed = include_bytes!("testdata/interop/pgp_signed.eml");
    let result = pgp::verify_message(signed, &[pau()]).expect("a signed message");
    assert!(matches!(result.verdict, pgp::SignatureVerdict::Good { .. }), "{:?}", result.verdict);
    assert_eq!(result.matches_sender, Some(true));
}

#[test]
fn a_gnupg_signed_message_changed_afterwards_is_bad_not_unknown() {
    let tampered = include_bytes!("testdata/interop/pgp_signed_tampered.eml");
    let result = pgp::verify_message(tampered, &[pau()]).unwrap();
    assert_eq!(result.verdict, pgp::SignatureVerdict::Bad);
}

#[test]
fn a_gnupg_signature_without_its_key_is_unknown_not_bad() {
    let signed = include_bytes!("testdata/interop/pgp_signed.eml");
    let result = pgp::verify_message(signed, &[]).unwrap();
    assert_eq!(result.verdict, pgp::SignatureVerdict::NoKey);
    assert_eq!(result.matches_sender, None, "nothing to say about a sender nobody verified");
}

#[test]
fn a_signature_made_while_its_key_was_valid_still_checks_out_after_it_expired() {
    let signed = include_bytes!("testdata/interop/pgp_signed_by_expired_key.eml");
    let olga = pgp::read_cert(OLGA_PUBLIC).unwrap().0;
    let result = pgp::verify_message(signed, &[olga]).unwrap();
    assert!(matches!(result.verdict, pgp::SignatureVerdict::Good { .. }), "{:?}", result.verdict);
}

#[test]
fn a_gnupg_encrypted_and_signed_message_opens_with_its_inner_signature() {
    let raw = include_bytes!("testdata/interop/pgp_encrypted_signed.eml");
    let (key, _) = pgp::read_secret_key(FIXTURE_SECRET).unwrap();
    let opened = pgp::decrypt_message(raw, &[key, pau()], None).unwrap();
    assert!(opened.body.contains("Hello from GnuPG."));
    assert!(matches!(opened.signature, Some(pgp::SignatureVerdict::Good { .. })), "{:?}", opened.signature);
}

#[test]
fn an_openssl_signature_checks_out_against_the_held_certificate() {
    let signed = include_bytes!("testdata/interop/smime_signed_detached.eml");
    let held = smime::certs_from_der(&[SARA_DER.to_vec()]);
    let result = smime::verify_message(signed, &held).expect("a signed message");
    assert!(matches!(result.verdict, smime::SignatureVerdict::Good { .. }), "{:?}", result.verdict);
    assert_eq!(result.matches_sender, Some(true));
    // Not held: it still checks out, but is said to be from a certificate
    // the reader has not accepted.
    let alone = smime::verify_message(signed, &[]).unwrap();
    assert!(matches!(alone.verdict, smime::SignatureVerdict::ValidUntrusted { .. }), "{:?}", alone.verdict);
}

#[test]
fn an_openssl_enveloped_message_opens() {
    let raw = include_bytes!("testdata/interop/smime_enveloped_aes256.eml");
    let opened = smime::decrypt_message(raw, &sara()).unwrap();
    assert!(opened.body.contains("Hello from GnuPG."), "{}", opened.body);
}

#[test]
fn an_algorithm_not_implemented_is_named_as_unsupported_not_as_damage() {
    for (raw, what) in [
        (&include_bytes!("testdata/interop/smime_enveloped_oaep.eml")[..], "RSAES-OAEP"),
        (&include_bytes!("testdata/interop/smime_authenveloped_gcm.eml")[..], "AES-GCM"),
    ] {
        match smime::decrypt_message(raw, &sara()) {
            Err(smime::DecryptionFailure::Unsupported { algorithm }) => assert!(algorithm.contains(what), "{algorithm}"),
            other => panic!("{what}: {other:?}"),
        }
    }
}

// ---- What this writes, read by GnuPG and OpenSSL -----------------------------

/// Runs a tool when it is installed. In CI it must be (both are on the
/// runner images); on a developer machine without them the test says so.
fn tool(name: &str) -> Option<()> {
    let present = Command::new(name).arg("--version").output().is_ok()
        || Command::new(name).arg("version").output().is_ok();
    if !present && std::env::var_os("CI").is_some() {
        panic!("{name} is needed for the interoperability tests in CI");
    }
    if !present {
        eprintln!("skipping: {name} is not installed");
    }
    present.then_some(())
}

fn run(program: &str, args: &[&str], input: &[u8], env: &[(&str, &str)]) -> (bool, Vec<u8>, String) {
    let mut child = Command::new(program)
        .args(args)
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let out = child.wait_with_output().unwrap();
    (out.status.success(), out.stdout, String::from_utf8_lossy(&out.stderr).into_owned())
}

const MESSAGE: &[u8] = b"From: Pau Interop <pau@example.test>\r\nTo: fixture@example.test\r\nSubject: From Oreneta\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from Oreneta.\r\n";

/// One part of a multipart message, as RFC 2046 delimits it: after its
/// boundary line, up to the CRLF that belongs to the next boundary.
fn mime_part(message: &[u8], index: usize) -> Vec<u8> {
    let text = String::from_utf8_lossy(message);
    let boundary = text.split("boundary=\"").nth(1).unwrap().split('"').next().unwrap().to_string();
    let opening = format!("--{boundary}\r\n");
    let closing = format!("\r\n--{boundary}");
    let mut start = 0;
    for _ in 0..=index {
        start += text[start..].find(&opening).unwrap() + opening.len();
    }
    let end = start + text[start..].find(&closing).unwrap();
    text[start..end].as_bytes().to_vec()
}

#[test]
fn gnupg_verifies_and_decrypts_what_this_writes() {
    if tool("gpg").is_none() {
        return;
    }
    let home = std::env::temp_dir().join(format!("oreneta-interop-gpg-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let env = [("GNUPGHOME", home.to_str().unwrap())];
    // GnuPG holds Pau's public key and the fixture's secret key.
    assert!(run("gpg", &["--batch", "--import"], PAU_PUBLIC.as_bytes(), &env).0);
    assert!(run("gpg", &["--batch", "--import"], FIXTURE_SECRET.as_bytes(), &env).0);

    let (signer, _) = pgp::read_secret_key(PAU_SECRET).unwrap();
    let (recipient, _) = pgp::read_secret_key(FIXTURE_SECRET).unwrap();
    let recipient = recipient.strip_secret_key_material();

    // Signed: GnuPG checks the detached signature over the first part.
    let signed = pgp::protect_message(
        MESSAGE,
        pgp::Protect { sign: true, encrypt: false },
        Some(&signer),
        None,
        &[],
        &[],
    )
    .unwrap();
    // One MIME-Version, and a signature armoured as a signature.
    let text = String::from_utf8_lossy(&signed);
    assert_eq!(text.matches("MIME-Version:").count(), 1, "{text}");
    assert!(text.contains("-----BEGIN PGP SIGNATURE-----"), "{text}");
    let part = mime_part(&signed, 0);
    let signature_part = mime_part(&signed, 1);
    let signature = String::from_utf8_lossy(&signature_part);
    let armour = &signature[signature.find("-----BEGIN").unwrap()..];
    std::fs::write(home.join("part"), &part).unwrap();
    std::fs::write(home.join("part.sig"), armour).unwrap();
    let (ok, _, err) = run(
        "gpg",
        &["--batch", "--verify", home.join("part.sig").to_str().unwrap(), home.join("part").to_str().unwrap()],
        b"",
        &env,
    );
    assert!(ok, "gpg refused the signature: {err}");
    assert!(err.contains("Good signature"), "{err}");

    // Signed and encrypted: GnuPG opens it and finds the signature inside.
    let sealed = pgp::protect_message(
        MESSAGE,
        pgp::Protect { sign: true, encrypt: true },
        Some(&signer),
        None,
        &[recipient],
        &["fixture@example.test".into()],
    )
    .unwrap();
    assert_eq!(String::from_utf8_lossy(&sealed).matches("MIME-Version:").count(), 1);
    let encrypted_part = mime_part(&sealed, 1);
    let encrypted = String::from_utf8_lossy(&encrypted_part);
    let armour = &encrypted[encrypted.find("-----BEGIN").unwrap()..];
    let (ok, plain, err) = run("gpg", &["--batch", "--decrypt"], armour.as_bytes(), &env);
    assert!(ok, "gpg could not open it: {err}");
    assert!(String::from_utf8_lossy(&plain).contains("Hello from Oreneta."));
    assert!(err.contains("Good signature"), "{err}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn openssl_verifies_and_decrypts_what_this_writes() {
    if tool("openssl").is_none() {
        return;
    }
    let dir = std::env::temp_dir().join(format!("oreneta-interop-openssl-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = |name: &str| dir.join(name).to_str().unwrap().to_string();
    std::fs::write(dir.join("sara.p12"), SARA_P12).unwrap();
    std::fs::write(dir.join("sara.der"), SARA_DER).unwrap();
    // OpenSSL needs the key and certificate as PEM; it makes them itself from
    // the same PKCS#12 file this reads.
    let (ok, _, err) = run(
        "openssl",
        &["pkcs12", "-in", &path("sara.p12"), "-passin", "pass:interop", "-nodes", "-out", &path("sara.pem")],
        b"",
        &[],
    );
    assert!(ok, "{err}");

    let identity = sara();
    let held = smime::certs_from_der(&[SARA_DER.to_vec()]);
    let message = String::from_utf8_lossy(MESSAGE).replace("pau@example.test", "sara@example.test").replace("fixture@example.test", "sara@example.test");

    let signed = smime::protect_message(
        message.as_bytes(),
        smime::Protect { sign: true, encrypt: false },
        Some(&identity),
        &[],
        &[],
    )
    .unwrap();
    assert_eq!(String::from_utf8_lossy(&signed).matches("MIME-Version:").count(), 1);
    std::fs::write(dir.join("signed.eml"), &signed).unwrap();
    let (ok, _, err) = run(
        "openssl",
        &["smime", "-verify", "-in", &path("signed.eml"), "-CAfile", &path("sara.pem"), "-purpose", "any"],
        b"",
        &[],
    );
    assert!(ok, "openssl refused the signature: {err}");

    let sealed = smime::protect_message(
        message.as_bytes(),
        smime::Protect { sign: false, encrypt: true },
        None,
        &held,
        &["sara@example.test".into()],
    )
    .unwrap();
    std::fs::write(dir.join("sealed.eml"), &sealed).unwrap();
    let (ok, plain, err) =
        run("openssl", &["smime", "-decrypt", "-in", &path("sealed.eml"), "-inkey", &path("sara.pem")], b"", &[]);
    assert!(ok, "openssl could not open it: {err}");
    assert!(String::from_utf8_lossy(&plain).contains("Hello from Oreneta."));
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- Never in the clear, never a key in a report ------------------------------

#[test]
fn encryption_asked_for_never_falls_back_to_the_clear() {
    let missing = pgp::protect_message(
        MESSAGE,
        pgp::Protect { sign: false, encrypt: true },
        None,
        None,
        &[pau()],
        &["fixture@example.test".into(), "pau@example.test".into()],
    );
    assert_eq!(missing, Err(pgp::ProtectFailure::NoRecipientKey { missing: vec!["fixture@example.test".into()] }));
    let none = smime::protect_message(
        MESSAGE,
        smime::Protect { sign: false, encrypt: true },
        None,
        &[],
        &["fixture@example.test".into()],
    );
    assert!(none.is_err(), "no certificate, no message");
}

#[test]
fn key_material_never_appears_in_what_is_reported_about_a_key() {
    let (_, info) = pgp::read_secret_key(PAU_SECRET).unwrap();
    let reported = serde_json::to_string(&info).unwrap();
    assert!(!reported.contains("PRIVATE KEY") && !reported.contains("-----BEGIN"), "{reported}");
    let reported = serde_json::to_string(&sara().info).unwrap();
    assert!(!reported.contains("PRIVATE") && !reported.contains("-----BEGIN"), "{reported}");
    // A wrong password says so without echoing anything it read.
    let failure = pkcs12::read_pkcs12(SARA_P12, "wrong").err().map(|e| format!("{e:?}")).unwrap_or_default();
    assert!(!failure.contains("interop"), "{failure}");
}

