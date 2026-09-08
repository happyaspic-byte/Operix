import importlib.util
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/create-deploy-manifest.py"
REVISION = "a" * 40
IMAGE_ID = "sha256:" + "b" * 64


def module():
    spec = importlib.util.spec_from_file_location("nas_manifest", SCRIPT)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "deployment manifest helper is missing")
        self.helper = module()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.archive = Path(self.directory.name) / "operix-image.tar.gz"
        self.archive.write_bytes(b"abc")
        self.manifest = self.archive.with_name("manifest.json")

    def create(self, **changes):
        arguments = dict(revision=REVISION, image_id=IMAGE_ID, run_id="123")
        arguments.update(changes)
        return self.helper.create_manifest(self.archive, **arguments)

    def save(self, data):
        self.manifest.write_text(json.dumps(data))

    def test_manifest_binds_archive_bytes_and_tested_image_to_revision(self):
        self.assertEqual(self.create(), {
            "schema": 1,
            "repository": "happyaspic-byte/Operix",
            "revision": "a" * 40,
            "image": "operix:github-" + "a" * 40,
            "image_id": "sha256:" + "b" * 64,
            "archive": "operix-image.tar.gz",
            "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "size": 3,
            "run_id": "123",
        })

    def test_creation_rejects_ambiguous_revision_image_and_run_identifiers(self):
        for changes in ({"revision": "main"}, {"revision": "A" * 40},
                        {"image_id": "operix:latest"}, {"run_id": "0"},
                        {"run_id": 123}, {"run_id": "123\n"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.create(**changes)

    def test_empty_and_over_two_gigabyte_archives_are_rejected_before_hashing(self):
        for size in (0, 2_000_000_001):
            with self.subTest(size=size):
                with self.archive.open("wb") as stream:
                    stream.truncate(size)
                with self.assertRaises(ValueError):
                    self.create()

    def test_archive_symlinks_are_rejected(self):
        target = self.archive.with_name("other.tar.gz")
        target.write_bytes(b"abc")
        self.archive.unlink()
        self.archive.symlink_to(target)
        with self.assertRaises(ValueError):
            self.create()

    def test_existing_manifest_verifies_bytes_without_rewriting_its_run(self):
        self.save(self.create(run_id="77"))
        verified = self.helper.verify_manifest(self.manifest, self.archive, REVISION)
        self.assertEqual(verified["run_id"], "77")
        self.assertEqual(self.manifest.read_text(), json.dumps(verified))

    def test_modified_archive_fails_verification(self):
        self.save(self.create())
        self.archive.write_bytes(b"abd")
        with self.assertRaises(ValueError):
            self.helper.verify_manifest(self.manifest, self.archive, REVISION)

    def test_manifest_rejects_wrong_repository_revision_tag_size_and_schema(self):
        for key, value in (("repository", "attacker/Operix"),
                           ("revision", "c" * 40), ("image", "operix:latest"),
                           ("archive", "../operix-image.tar.gz"), ("size", True),
                           ("size", 4), ("schema", True), ("schema", 2),
                           ("extra", "unexpected")):
            with self.subTest(key=key, value=value):
                data = self.create()
                data[key] = value
                self.save(data)
                with self.assertRaises(ValueError):
                    self.helper.verify_manifest(self.manifest, self.archive, REVISION)

    def test_duplicate_manifest_fields_are_rejected(self):
        self.manifest.write_text(json.dumps(self.create())[:-1] + ', "schema": 1}')
        with self.assertRaises(ValueError):
            self.helper.verify_manifest(self.manifest, self.archive, REVISION)

    def test_publish_cli_refuses_forks_pull_requests_and_other_branches(self):
        self.save(self.create())
        trusted = {"GITHUB_REPOSITORY": "happyaspic-byte/Operix",
                   "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "push",
                   "GITHUB_SHA": REVISION, "GITHUB_RUN_ID": "123"}
        for changes in ({"GITHUB_REPOSITORY": "other/Operix"},
                        {"GITHUB_REF": "refs/heads/nas-deploy"},
                        {"GITHUB_EVENT_NAME": "pull_request"},
                        {"GITHUB_SHA": "c" * 40}):
            with self.subTest(changes=changes):
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), "publish", str(self.manifest),
                     str(self.archive), "--revision", REVISION],
                    env=trusted | changes, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("restricted to the trusted repository", result.stderr)


class FakeGitHub:
    """Model the external API boundary, retaining observable publication state."""

    def __init__(self, manifest_bytes, archive_bytes=b"abc", release=None):
        self.main = REVISION
        self.release = release
        self.manifest_bytes = manifest_bytes
        self.archive_bytes = archive_bytes
        self.pointer = None
        self.branch_exists = False
        self.mutations = []
        self.advance_before_pointer = False
        self.run_conclusion = "success"

    def api(self, endpoint, method="GET", payload=None, missing_ok=False):
        if method != "GET":
            self.mutations.append((method, endpoint, payload))
        if endpoint == "git/ref/heads/main":
            return {"object": {"sha": self.main, "type": "commit"}}
        if endpoint.startswith("releases/tags/"):
            return self.release if self.release and not self.release.get("draft") else None
        if endpoint.startswith("releases?per_page=100&page="):
            return [self.release] if self.release else []
        if endpoint.startswith("git/ref/tags/"):
            return {"object": {"sha": REVISION, "type": "commit"}}
        if endpoint.startswith("actions/runs/"):
            return {"path": ".github/workflows/ci.yml", "event": "push",
                    "head_branch": "main", "head_sha": REVISION,
                    "status": "completed", "conclusion": self.run_conclusion,
                    "repository": {"full_name": "happyaspic-byte/Operix"}}
        if endpoint == "releases" and method == "POST":
            self.release = dict(payload, id=55, immutable=False, assets=[])
            return self.release
        if endpoint == "releases/55" and method == "PATCH":
            self.release.update(payload, immutable=True)
            return self.release
        if endpoint == "git/ref/heads/nas-deploy":
            return {"object": {"sha": "d" * 40}} if self.branch_exists else None
        if endpoint == "git/refs" and method == "POST":
            self.branch_exists = True
            return {"ref": payload["ref"]}
        if endpoint == "contents/manifest.json?ref=nas-deploy":
            if self.advance_before_pointer:
                self.main = "e" * 40
            if self.pointer is None:
                return None
            return {"sha": "f" * 40,
                    "content": base64.b64encode(self.pointer).decode()}
        if endpoint == "contents/manifest.json" and method == "PUT":
            self.pointer = base64.b64decode(payload["content"])
            return {"commit": {"sha": "f" * 40}}
        raise AssertionError("Unexpected GitHub request: " + method + " " + endpoint)

    def upload(self, tag, manifest, archive):
        if not self.release["draft"]:
            raise AssertionError("Published assets must never be changed")
        self.mutations.append(("UPLOAD", tag, None))
        self.manifest_bytes = Path(manifest).read_bytes()
        self.archive_bytes = Path(archive).read_bytes()
        self.release["assets"] = [
            {"name": "manifest.json", "size": len(self.manifest_bytes)},
            {"name": "operix-image.tar.gz", "size": len(self.archive_bytes)},
        ]

    def download(self, tag, directory):
        Path(directory, "manifest.json").write_bytes(self.manifest_bytes)
        Path(directory, "operix-image.tar.gz").write_bytes(self.archive_bytes)


class PublisherTests(unittest.TestCase):
    create = ManifestTests.create
    save = ManifestTests.save

    def setUp(self):
        ManifestTests.setUp(self)
        self.assertTrue(hasattr(self.helper, "publish"), "release publisher is missing")
        self.save(self.create())
        self.github = FakeGitHub(self.manifest.read_bytes())

    def existing_release(self, run_id="77", immutable=True):
        self.github.manifest_bytes = json.dumps(self.create(run_id=run_id)).encode()
        self.github.release = {
            "id": 55, "tag_name": "deploy-" + REVISION,
            "target_commitish": REVISION, "draft": False,
            "prerelease": True, "immutable": immutable,
            "assets": [{"name": "manifest.json", "size": len(self.github.manifest_bytes)},
                       {"name": "operix-image.tar.gz", "size": 3}],
        }

    def publish(self):
        return self.helper.publish(self.github, self.manifest, self.archive, REVISION, "123")

    def test_stale_main_does_not_create_release_or_pointer(self):
        self.github.main = "c" * 40
        self.assertFalse(self.publish())
        self.assertEqual(self.github.mutations, [])

    def test_publishes_complete_draft_then_identical_manifest_pointer(self):
        self.assertTrue(self.publish())
        self.assertEqual(self.github.pointer, self.manifest.read_bytes())
        events = [event[0] for event in self.github.mutations]
        self.assertEqual(events, ["POST", "UPLOAD", "PATCH", "POST", "PUT"])
        self.assertEqual(self.github.mutations[0][2]["target_commitish"], REVISION)
        self.assertTrue(self.github.mutations[0][2]["draft"])
        self.assertEqual(self.github.mutations[2][2]["make_latest"], "false")
        self.assertEqual(self.github.mutations[3][2],
                         {"ref": "refs/heads/nas-deploy", "sha": REVISION})

    def test_immutable_rerun_reuses_verified_assets_and_original_run_id(self):
        self.existing_release()
        self.assertTrue(self.publish())
        self.assertEqual(self.github.pointer, self.github.manifest_bytes)
        self.assertEqual(json.loads(self.github.pointer)["run_id"], "77")
        self.assertFalse(any(event[0] in ("UPLOAD", "PATCH")
                             for event in self.github.mutations))

    def test_corrupted_published_archive_never_advances_pointer(self):
        self.existing_release()
        self.github.archive_bytes = b"abd"
        with self.assertRaises(ValueError):
            self.publish()
        self.assertIsNone(self.github.pointer)
        self.assertEqual(self.github.mutations, [])

    def test_mutable_published_release_is_rejected(self):
        self.existing_release(immutable=False)
        with self.assertRaises(ValueError):
            self.publish()
        self.assertEqual(self.github.mutations, [])

    def test_previous_failed_workflow_release_cannot_be_reused(self):
        self.existing_release()
        self.github.run_conclusion = "failure"
        with self.assertRaises(ValueError):
            self.publish()
        self.assertIsNone(self.github.pointer)

    def test_main_advancing_before_pointer_write_prevents_stale_deployment(self):
        self.github.advance_before_pointer = True
        self.assertFalse(self.publish())
        self.assertIsNone(self.github.pointer)

    def test_identical_existing_pointer_is_not_recommitted_or_branch_reset(self):
        self.existing_release()
        self.github.branch_exists = True
        self.github.pointer = self.github.manifest_bytes
        self.assertTrue(self.publish())
        self.assertEqual(self.github.mutations, [])

    def test_existing_pointer_update_uses_file_sha_without_resetting_branch(self):
        self.github.branch_exists = True
        self.github.pointer = b'{"older": true}'
        self.assertTrue(self.publish())
        writes = [event for event in self.github.mutations if event[1] == "contents/manifest.json"]
        self.assertEqual(writes[0][2]["sha"], "f" * 40)
        self.assertFalse(any(event[1] == "git/refs" for event in self.github.mutations))

    def test_new_artifact_must_belong_to_current_workflow_run(self):
        self.save(self.create(run_id="456"))
        with self.assertRaises(ValueError):
            self.publish()
        self.assertEqual(self.github.mutations, [])

    def test_interrupted_draft_is_recovered_without_creating_duplicate_release(self):
        self.github.release = {"id": 55, "tag_name": "deploy-" + REVISION,
                               "target_commitish": REVISION, "draft": True}
        self.assertTrue(self.publish())
        self.assertFalse(any(event[0:2] == ("POST", "releases")
                             for event in self.github.mutations))


if __name__ == "__main__":
    unittest.main()
