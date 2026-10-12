use super::*;

fn set(rules: &str) -> FilterSet {
    FilterSet::parse(&format!("[Adblock Plus 2.0]\n! Title: EasyPrivacy\n! Version: test\n{rules}"))
}

#[test]
fn the_bundled_snapshot_reads_and_says_what_it_is() {
    let bundled = FilterSet::parse(BUNDLED);
    assert_eq!(bundled.title, "EasyPrivacy");
    assert_eq!(bundled.version, "4b79596e08b7");
    assert!(bundled.rule_count() > 40_000, "{}", bundled.rule_count());
    assert!(validate(BUNDLED).is_ok());
}

#[test]
fn real_mail_trackers_are_blocked_and_ordinary_images_are_not() {
    let list = FilterSet::parse(BUNDLED);
    for tracker in [
        "https://us5.list-manage.com/track/open.php?u=abc&id=def",
        "https://email.acemlna.com/lt.php?x=1",
        "https://track.hubspot.com/img/trackers/blank001.gif",
    ] {
        assert!(list.blocking_rule(tracker).is_some(), "{tracker}");
    }
    for fine in [
        "https://images.example.org/logo.png",
        "https://cdn.shop.example/newsletter/hero.jpg",
        // EasyPrivacy's google-analytics rule for scripts is not one for its
        // images; the list does block the domain's paths, as it says.
        "https://www.example.net/assets/banner.png",
    ] {
        assert_eq!(list.blocking_rule(fine), None, "{fine}");
    }
}

#[test]
fn rule_syntax_means_what_the_list_means() {
    let list = set(
        "||tracker.example^\n\
         /pixel.gif?$image\n\
         |https://start.example/a|\n\
         ||cdn.example/*/open^\n\
         ||scripts.example^$script\n\
         ||site-only.example^$domain=news.example\n\
         ||not-here.example^$domain=~news.example\n\
         ||first-party.example^$~third-party\n\
         ||rewrite.example^$removeparam=utm\n\
         example.com##.banner\n\
         /^https?:\\/\\/regex\\./\n\
         ||allowed.example^\n\
         @@||allowed.example/ok/\n\
         ||forced.example^$important\n\
         @@||forced.example^",
    );
    let blocked = |url: &str| list.blocking_rule(url).is_some();
    // `||` covers the host and its subdomains, not look-alikes.
    assert!(blocked("https://tracker.example/x.gif"));
    assert!(blocked("http://a.b.tracker.example"));
    assert!(!blocked("https://nottracker.example/x.gif"));
    assert!(!blocked("https://tracker.example.evil.test/x"), "^ needs a separator after the host");
    assert!(blocked("https://any.example/img/pixel.gif?id=1"));
    // `|` anchors both ends.
    assert!(blocked("https://start.example/a"));
    assert!(!blocked("https://start.example/ab"));
    // `*` and `^` together.
    assert!(blocked("https://cdn.example/n/42/open?x"));
    assert!(blocked("https://cdn.example/n/42/open"));
    assert!(!blocked("https://cdn.example/n/42/opened"));
    // Options that cannot apply to mail make the rule not apply.
    assert!(!blocked("https://scripts.example/a.png"));
    assert!(!blocked("https://site-only.example/a.png"));
    assert!(blocked("https://not-here.example/a.png"));
    assert!(!blocked("https://first-party.example/a.png"));
    assert!(!blocked("https://rewrite.example/a.png"));
    // Exceptions, and `important` over them.
    assert!(blocked("https://allowed.example/no/1.png"));
    assert!(!blocked("https://allowed.example/ok/1.png"));
    assert!(blocked("https://forced.example/1.png"));
    // Only addresses that would be fetched are judged.
    assert!(!blocked("data:image/gif;base64,AAAA"));
    assert!(!blocked("cid:part1"));
    assert!(blocked("//tracker.example/p.gif"), "scheme-relative");
}

#[test]
fn a_message_is_kept_from_fetching_trackers_however_they_are_written() {
    // Synthetic message: nothing here is ever requested.
    let html = r#"<html><head><style>
        .a { background: url("https://tracker.example/bg.png") }
        @import url(https://tracker.example/s.css);
        .b { background-image: url(https://images.example.org/ok.png) }
    </style></head><body>
      <img src="https://tracker.example/open.gif" width="1" height="1">
      <img src="h&#116;tps://tracker.example/encoded.gif">
      <img srcset="https://images.example.org/a.png 1x, https://tracker.example/b.png 2x">
      <table><tr><td background="https://tracker.example/td.png">x</td></tr></table>
      <div style="background:url('h\74tps://tracker.example/escaped.png')">y</div>
      <img src="https://images.example.org/logo.png">
      <a href="https://tracker.example/click">a link</a>
    </body></html>"#;
    let list = set("||tracker.example^");
    let blocked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let out = crate::parse::sanitize_email_html_for_test(html, std::sync::Arc::new(list), blocked.clone());
    let blocked = blocked.lock().unwrap();
    let urls: Vec<&str> = blocked.iter().map(|b| b.url.as_str()).collect();
    // `srcset` never survives sanitizing at all, so it fetches nothing.
    for wanted in ["open.gif", "encoded.gif", "td.png", "escaped.png", "bg.png", "s.css"] {
        assert!(urls.iter().any(|u| u.ends_with(wanted)), "{wanted} not blocked: {urls:?}");
    }
    // Nothing of a tracker address is left to fetch; ordinary images and the
    // link stay.
    let without_links = out.replace("https://tracker.example/click", "");
    assert!(!without_links.contains("tracker.example"), "{out}");
    assert!(out.contains("https://images.example.org/logo.png"));
    assert!(!out.contains("srcset"));
    assert!(out.contains("https://images.example.org/ok.png"));
    assert!(out.contains(r#"href="https://tracker.example/click""#));
    assert!(blocked.iter().all(|b| b.rule == "||tracker.example^"));
}

#[test]
fn an_update_is_checked_and_a_bad_one_keeps_the_list_there_was() {
    let dir = std::env::temp_dir().join(format!("oreneta-privacy-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    assert!(install("<html>not a list</html>", &dir).is_err());
    assert!(install("[Adblock Plus 2.0]\n! Title: EasyList\n||a.example^", &dir).is_err(), "another list");
    assert!(install("[Adblock Plus 2.0]\n! Title: EasyPrivacy\n||a.example^", &dir).is_err(), "too few rules");
    assert!(validate(&"x".repeat(MAX_LIST_BYTES + 1)).is_err(), "too large");
    assert!(!dir.join("easyprivacy.txt").exists(), "nothing written for a refused list");

    let mut good = String::from("[Adblock Plus 2.0]\n! Title: EasyPrivacy\n! Version: 999\n");
    for i in 0..MIN_RULES {
        good.push_str(&format!("||t{i}.example^\n"));
    }
    let info = install(&good, &dir).unwrap();
    assert_eq!((info.version.as_str(), info.rules, info.source.as_str()), ("999", MIN_RULES, "updated"));
    assert!(current().blocking_rule("https://t7.example/p.gif").is_some());
    assert!(!dir.join("easyprivacy.txt.part").exists());

    // A later bad download leaves the good one in use.
    assert!(install("garbage", &dir).is_err());
    assert_eq!(current().version, "999");
    reset(&dir).unwrap();
    assert_eq!(current().version, "4b79596e08b7");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_message_can_be_let_load_trackers_and_that_is_per_account() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::store::run_migrations(&conn).unwrap();
    assert!(protects(&conn, "acct", "<m1@example.test>"));
    set_exception(&conn, "acct", "<M1@example.test>", true).unwrap();
    assert!(!protects(&conn, "acct", "m1@example.test"));
    assert!(protects(&conn, "other", "m1@example.test"));
    set_exception(&conn, "acct", "m1@example.test", false).unwrap();
    assert!(protects(&conn, "acct", "m1@example.test"));
    assert!(protects(&conn, "acct", ""), "no Message-ID: always protected");
    assert!(set_exception(&conn, "acct", " ", true).is_err());
}

