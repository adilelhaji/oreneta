use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

/// Serves files from memory, counting what was asked for.
struct Fake {
    files: HashMap<String, Vec<u8>>,
    asked: Mutex<Vec<String>>,
    /// Ends this file early, as a dropped connection would.
    cut: Option<(String, usize)>,
}

impl Source for Fake {
    fn open(&self, url: &str) -> std::result::Result<Box<dyn Read + Send>, String> {
        self.asked.lock().unwrap().push(url.to_string());
        let name = url.rsplit('/').next().unwrap().to_string();
        let mut bytes = self.files.get(&name).cloned().ok_or("404")?;
        if let Some((cut, at)) = &self.cut {
            if *cut == name {
                bytes.truncate(*at);
            }
        }
        Ok(Box::new(std::io::Cursor::new(bytes)))
    }
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn model(bytes: &[(&str, Vec<u8>)]) -> (Pair, Fake) {
    let pair = Pair {
        from: "xx".into(),
        to: "yy".into(),
        files: bytes
            .iter()
            .map(|(name, data)| ModelFile {
                part: "model".into(),
                name: name.to_string(),
                size: data.len() as u64,
                sha256: sha(data),
            })
            .collect(),
    };
    let fake = Fake {
        files: bytes.iter().map(|(n, d)| (n.to_string(), d.clone())).collect(),
        asked: Mutex::new(vec![]),
        cut: None,
    };
    (pair, fake)
}

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("oreneta-models-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn the_registry_offers_only_production_models_and_routes_through_english() {
    let pairs = registry();
    assert_eq!(pairs.len(), 19);
    assert!(pairs.iter().all(|p| p.files.iter().all(|f| f.sha256.len() == 64)));
    assert!(pairs.iter().all(|p| !p.files.iter().any(|f| f.part == "qualityModel")));
    let esen = pair("es", "en").unwrap();
    assert_eq!(esen.size(), 17_140_755 + 3_860_888 + 825_463);
    assert_eq!(
        languages(),
        ["bg", "cs", "de", "en", "es", "et", "fr", "it", "nb", "pl", "pt"].map(String::from)
    );
    let keys = |r: Vec<&Pair>| r.iter().map(|p| p.key()).collect::<Vec<_>>();
    assert_eq!(keys(route("es", "en").unwrap()), ["esen"]);
    assert_eq!(keys(route("es", "fr").unwrap()), ["esen", "enfr"]);
    assert!(route("en", "nb").is_err(), "only Norwegian to English exists");
    assert!(route("ca", "en").is_err());
    assert!(route("es", "es").is_err());
}

#[test]
fn a_registry_naming_a_path_instead_of_a_file_is_refused() {
    let bad = r#"{"xxyy":{"model":{"name":"../evil","size":1,"expectedSha256Hash":"0000000000000000000000000000000000000000000000000000000000000000"}}}"#;
    assert!(parse_registry(bad).is_err());
}

#[test]
fn a_model_is_in_place_only_after_every_file_checks_out() {
    let d = dir("ok");
    let (pair, fake) = model(&[("model.bin", vec![7u8; 200_000]), ("vocab.spm", b"vocab".to_vec())]);
    let mut seen = vec![];
    download(&d, &pair, &fake, &AtomicBool::new(false), u64::MAX, &mut |done, total| {
        seen.push((done, total))
    })
    .unwrap();
    assert!(installed(&d, &pair));
    assert_eq!(seen.first(), Some(&(0, 200_005)));
    assert_eq!(seen.last(), Some(&(200_005, 200_005)));
    assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0));
    assert_eq!(
        fake.asked.lock().unwrap()[0],
        format!("{BASE_URL}xxyy/model.bin"),
        "only ever from the one source"
    );
    assert!(!staging(&d, &pair).exists());
    remove(&d, &pair).unwrap();
    assert!(!installed(&d, &pair));
}

#[test]
fn a_damaged_or_wrong_file_is_never_installed() {
    let d = dir("bad");
    let (pair, mut fake) = model(&[("model.bin", vec![1u8; 1000]), ("vocab.spm", b"vocab".to_vec())]);
    // Same size, different bytes.
    fake.files.insert("vocab.spm".into(), b"VOCAB".to_vec());
    let err = download(&d, &pair, &fake, &AtomicBool::new(false), u64::MAX, &mut |_, _| {}).unwrap_err();
    assert_eq!(err, DownloadError::Integrity { file: "vocab.spm".into() });
    assert!(!installed(&d, &pair));
    assert!(!staging(&d, &pair).exists(), "nothing half-written is left");

    // Longer than published: stops reading it.
    fake.files.insert("vocab.spm".into(), vec![0u8; 10_000_000]);
    let err = download(&d, &pair, &fake, &AtomicBool::new(false), u64::MAX, &mut |_, _| {}).unwrap_err();
    assert_eq!(err, DownloadError::Integrity { file: "vocab.spm".into() });
}

#[test]
fn an_interrupted_download_leaves_nothing_and_the_next_one_starts_clean() {
    let d = dir("cut");
    let (pair, mut fake) = model(&[("model.bin", vec![3u8; 300_000]), ("vocab.spm", b"vocab".to_vec())]);
    fake.cut = Some(("model.bin".into(), 100_000));
    assert!(matches!(
        download(&d, &pair, &fake, &AtomicBool::new(false), u64::MAX, &mut |_, _| {}),
        Err(DownloadError::Integrity { .. })
    ));
    assert!(!installed(&d, &pair));

    // The app closed mid-download: the staging folder is cleared at startup.
    std::fs::create_dir_all(staging(&d, &pair)).unwrap();
    std::fs::write(staging(&d, &pair).join("model.bin"), b"partial").unwrap();
    clean_partial(&d);
    assert!(!staging(&d, &pair).exists());

    fake.cut = None;
    download(&d, &pair, &fake, &AtomicBool::new(false), u64::MAX, &mut |_, _| {}).unwrap();
    assert!(installed(&d, &pair));
}

#[test]
fn a_cancelled_download_stops_and_leaves_nothing() {
    let d = dir("cancel");
    let (pair, fake) = model(&[("model.bin", vec![5u8; 1_000_000])]);
    let cancel = AtomicBool::new(false);
    let err = download(&d, &pair, &fake, &cancel, u64::MAX, &mut |done, _| {
        if done > 100_000 {
            cancel.store(true, Ordering::Relaxed);
        }
    })
    .unwrap_err();
    assert_eq!(err, DownloadError::Cancelled);
    assert!(!installed(&d, &pair));
    assert!(!staging(&d, &pair).exists());
}

#[test]
fn models_stay_within_the_space_allowed() {
    let d = dir("quota");
    let (pair, fake) = model(&[("model.bin", vec![9u8; 5000])]);
    let err = download(&d, &pair, &fake, &AtomicBool::new(false), 4000, &mut |_, _| {}).unwrap_err();
    assert_eq!(err, DownloadError::Quota { needed: 5000, allowed: 4000 });
    assert!(fake.asked.lock().unwrap().is_empty(), "refused before fetching anything");
}

#[test]
fn status_reports_what_is_installed_and_how_much_space_it_takes() {
    let d = dir("status");
    let esen = pair("es", "en").unwrap();
    std::fs::create_dir_all(d.join("esen")).unwrap();
    for f in &esen.files {
        std::fs::File::create(d.join("esen").join(&f.name)).unwrap().set_len(f.size).unwrap();
    }
    let s = status(&d, DEFAULT_QUOTA_BYTES);
    assert!(s.pairs.iter().find(|p| p.pair.key() == "esen").unwrap().installed);
    assert_eq!(s.pairs.iter().filter(|p| p.installed).count(), 1);
    assert_eq!(s.used, esen.size());
    // A file that shrank since is not counted as installed.
    std::fs::File::create(d.join("esen").join(&esen.files[0].name)).unwrap().set_len(1).unwrap();
    assert!(!installed(&d, esen));
}
