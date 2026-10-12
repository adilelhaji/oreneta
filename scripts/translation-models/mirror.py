#!/usr/bin/env python3
"""Copy Mozilla's translation models into a folder ready to publish (ADR-0031).

Reads the registry shipped with the app, downloads each file from Mozilla's
bucket and keeps it only if its size and SHA-256 are the ones the registry
names. Files are written flat as `<pair>-<name>`, the names the app asks the
release for. Nothing is changed in the files.

    python3 scripts/translation-models/mirror.py OUT_DIR [--pair esen ...]
"""

import argparse
import hashlib
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "meron-core/src/translation/registry.json"
SOURCE = "https://storage.googleapis.com/bergamot-models-sandbox/0.3.3/"


def files(registry, pairs=None):
    """(pair, file entry) for every model file, in a stable order."""
    for pair in sorted(registry):
        if pairs and pair not in pairs:
            continue
        for part in sorted(registry[pair]):
            yield pair, registry[pair][part]


def asset_name(pair, entry):
    return f"{pair}-{entry['name']}"


def fetch(url, out, size, sha256, opener=urllib.request.urlopen):
    """Write url to out; raise unless its size and hash match. Nothing is
    left at `out` when it does not."""
    digest = hashlib.sha256()
    written = 0
    part = out.with_name(out.name + ".part")
    try:
        with opener(url) as response, open(part, "wb") as sink:
            while chunk := response.read(1 << 16):
                written += len(chunk)
                if written > size:
                    raise ValueError(f"{url}: longer than {size} bytes")
                digest.update(chunk)
                sink.write(chunk)
        if written != size or digest.hexdigest() != sha256:
            raise ValueError(f"{url}: size or SHA-256 differs from the registry")
        part.rename(out)
    finally:
        part.unlink(missing_ok=True)


def main(argv=None, opener=urllib.request.urlopen):
    args = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    args.add_argument("out")
    args.add_argument("--pair", action="append", help="only these pairs (e.g. esen)")
    opts = args.parse_args(argv)
    registry = json.loads(REGISTRY.read_text())
    out = pathlib.Path(opts.out)
    out.mkdir(parents=True, exist_ok=True)
    count = 0
    for pair, entry in files(registry, opts.pair):
        target = out / asset_name(pair, entry)
        if target.exists() and target.stat().st_size == entry["size"]:
            if hashlib.sha256(target.read_bytes()).hexdigest() == entry["expectedSha256Hash"]:
                count += 1
                continue
        fetch(f"{SOURCE}{pair}/{entry['name']}", target, entry["size"], entry["expectedSha256Hash"], opener)
        count += 1
        print(target.name, flush=True)
    print(f"{count} files checked against the registry", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
