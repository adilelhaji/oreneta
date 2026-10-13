import hashlib
import io
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import mirror  # noqa: E402


class Fake:
    def __init__(self, files):
        self.files = files
        self.asked = []

    def __call__(self, url):
        self.asked.append(url)
        return io.BytesIO(self.files[url])


class MirrorTest(unittest.TestCase):
    def test_every_registry_file_gets_its_own_flat_name(self):
        registry = json.loads(mirror.REGISTRY.read_text())
        names = [mirror.asset_name(p, e) for p, e in mirror.files(registry)]
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all("/" not in n for n in names))

    def test_a_file_is_kept_only_when_it_matches_the_registry(self):
        good = b"model bytes"
        sha = hashlib.sha256(good).hexdigest()
        with tempfile.TemporaryDirectory() as d:
            out = pathlib.Path(d) / "xxyy-model.bin"
            mirror.fetch("u", out, len(good), sha, Fake({"u": good}))
            self.assertEqual(out.read_bytes(), good)
            out.unlink()
            for bad in (b"MODEL BYTES", b"model", good + b"!"):
                with self.assertRaises(ValueError):
                    mirror.fetch("u", out, len(good), sha, Fake({"u": bad}))
                self.assertEqual(list(pathlib.Path(d).iterdir()), [])

    def test_only_the_asked_pairs_are_fetched_and_a_short_file_stops_it(self):
        asked = []

        def opener(url):
            asked.append(url)
            return io.BytesIO(b"")

        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                mirror.main([d, "--pair", "esen"], opener)
            self.assertEqual(list(pathlib.Path(d).iterdir()), [])
        self.assertEqual(len(asked), 1)
        self.assertTrue(asked[0].startswith(mirror.SOURCE + "esen/"))


if __name__ == "__main__":
    unittest.main()
