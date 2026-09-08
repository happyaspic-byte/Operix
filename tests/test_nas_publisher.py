import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/publish-nas-compose.py"
REVISION = "a" * 40
IMAGE = "ghcr.io/happyaspic-byte/operix@sha256:" + "b" * 64


def load_helper():
    spec = importlib.util.spec_from_file_location("nas_publisher", SCRIPT)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def template():
    return {
        "name": "operix",
        "services": {
            name: {"image": "__OPERIX_IMAGE__", "environment": {"KEEP": "original"}}
            for name in ("migrate", "web", "worker")
        } | {
            "backup": {"image": "postgres:17", "environment": {"DEPLOYMENT_ID": "__DEPLOYMENT_ID__"}},
            "deployment-check": {"image": "alpine:3.22", "labels": {"operix.deployment": "__DEPLOYMENT_ID__"}},
            "https": {"image": "nginx:stable-alpine", "ports": ["172.30.1.99:9010:443"]},
        },
        "volumes": {"database": {"external": True, "name": "existing-operix-data"}},
    }


class FakeAPI:
    def __init__(self):
        self.main = REVISION
        self.head = "c" * 40
        self.commits = {self.head: {"tree": {"sha": "d" * 40}}}
        self.writes = []
        self.main_reads = 0
        self.advance_main = False
        self.conflicting_pointer = False

    def __call__(self, endpoint, method="GET", payload=None, missing_ok=False):
        if method != "GET":
            self.writes.append((endpoint, method, copy.deepcopy(payload)))
        if endpoint == "git/ref/heads/main":
            self.main_reads += 1
            if self.advance_main and self.main_reads > 1:
                self.main = "e" * 40
            return {"object": {"sha": self.main}}
        if endpoint == "git/ref/heads/nas-deploy":
            return {"object": {"sha": self.head}} if self.head else None
        if endpoint.startswith("git/commits/"):
            return self.commits[endpoint.rsplit("/", 1)[1]]
        if endpoint == "git/trees" and method == "POST":
            return {"sha": hashlib.sha1(json.dumps(payload, sort_keys=True).encode()).hexdigest()}
        if endpoint == "git/commits" and method == "POST":
            commit = hashlib.sha1(json.dumps(payload, sort_keys=True).encode()).hexdigest()
            self.commits[commit] = {"tree": {"sha": payload["tree"]}}
            return {"sha": commit}
        if endpoint == "git/refs/heads/nas-deploy" and method == "PATCH":
            if self.conflicting_pointer:
                raise RuntimeError("Non-fast-forward update rejected")
            self.head = payload["sha"]
            return {"object": {"sha": self.head}}
        if endpoint == "git/refs" and method == "POST":
            self.head = payload["sha"]
            return {"ref": payload["ref"]}
        raise AssertionError("Unexpected request: " + endpoint)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.exists(), "native Compose publisher is missing")
        self.helper = load_helper()

    def files(self):
        return self.helper.render(template(), REVISION, IMAGE, "123")

    def test_render_replaces_only_five_owned_fields_and_preserves_template(self):
        original = template()
        unchanged = copy.deepcopy(original)
        files = self.helper.render(original, REVISION, IMAGE, "123")
        expected = copy.deepcopy(original)
        for name in ("migrate", "web", "worker"):
            expected["services"][name]["image"] = IMAGE
        expected["services"]["backup"]["environment"]["DEPLOYMENT_ID"] = REVISION + "-123"
        expected["services"]["deployment-check"]["labels"]["operix.deployment"] = REVISION + "-123"
        self.assertEqual(json.loads(files["compose.yaml"]), expected)
        self.assertEqual(original, unchanged)
        self.assertEqual(set(files), {"compose.yaml", "deployment.json"})
        self.assertEqual(json.loads(files["deployment.json"]), {
            "schema": 1, "repository": "happyaspic-byte/Operix",
            "revision": REVISION, "image": IMAGE, "run_id": "123",
        })

    def test_mutable_tags_wrong_registry_and_malformed_identifiers_are_rejected(self):
        for revision, image, run_id in (
            (REVISION, "ghcr.io/happyaspic-byte/operix:latest", "123"),
            (REVISION, IMAGE.replace("happyaspic-byte", "attacker"), "123"),
            (REVISION, IMAGE[:-1], "123"), ("main", IMAGE, "123"),
            (REVISION, IMAGE, "0"), (REVISION, IMAGE, "123\n"),
        ):
            with self.subTest(image=image, revision=revision, run_id=run_id), self.assertRaises(ValueError):
                self.helper.render(template(), revision, image, run_id)

    def test_changed_template_marker_is_rejected_instead_of_overwriting_unowned_image(self):
        changed = template()
        changed["services"]["worker"]["image"] = "operator-selected-image"
        with self.assertRaises(ValueError):
            self.helper.render(changed, REVISION, IMAGE, "123")

    def test_cli_rejects_untrusted_context_before_reading_template_or_calling_github(self):
        environment = {"GITHUB_REPOSITORY": "happyaspic-byte/Operix",
                       "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "push",
                       "GITHUB_SHA": REVISION, "GITHUB_RUN_ID": "123"}
        for changes in ({"GITHUB_REPOSITORY": "fork/Operix"},
                        {"GITHUB_REF": "refs/heads/nas-deploy"},
                        {"GITHUB_EVENT_NAME": "pull_request"},
                        {"GITHUB_SHA": "f" * 40}, {"GITHUB_RUN_ID": "456"}):
            with self.subTest(changes=changes):
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), "--revision", REVISION, "--image", IMAGE,
                     "--run-id", "123", "--template", "template-must-not-be-read.json"],
                    env=environment | changes, text=True, capture_output=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("requires the trusted repository", result.stderr)

    def test_stale_revision_makes_no_git_writes(self):
        api = FakeAPI()
        api.main = "f" * 40
        self.assertEqual(self.helper.publish(api, self.files(), REVISION), "stale")
        self.assertEqual(api.writes, [])

    def test_tree_contains_only_deployment_files_and_preserves_branch_parent(self):
        api = FakeAPI()
        old_head = api.head
        self.assertEqual(self.helper.publish(api, self.files(), REVISION), "published")
        tree = next(payload for endpoint, _, payload in api.writes if endpoint == "git/trees")
        self.assertEqual(set(tree), {"tree"})
        self.assertEqual({item["path"] for item in tree["tree"]}, {"compose.yaml", "deployment.json"})
        commit = next(payload for endpoint, _, payload in api.writes if endpoint == "git/commits")
        self.assertEqual(commit["parents"], [old_head])
        self.assertEqual(api.writes[-1][0:2], ("git/refs/heads/nas-deploy", "PATCH"))
        self.assertIs(api.writes[-1][2]["force"], False)

    def test_main_advancing_before_ref_update_leaves_branch_unchanged(self):
        api = FakeAPI()
        old_head = api.head
        api.advance_main = True
        self.assertEqual(self.helper.publish(api, self.files(), REVISION), "stale")
        self.assertEqual(api.head, old_head)
        self.assertFalse(any(method == "PATCH" for _, method, _ in api.writes))

    def test_identical_deployment_does_not_create_another_commit(self):
        api = FakeAPI()
        self.helper.publish(api, self.files(), REVISION)
        old_head = api.head
        api.writes.clear()
        self.assertEqual(self.helper.publish(api, self.files(), REVISION), "unchanged")
        self.assertEqual(api.head, old_head)
        self.assertFalse(any(endpoint == "git/commits" for endpoint, _, _ in api.writes))

    def test_missing_branch_is_created_at_new_deployment_commit(self):
        api = FakeAPI()
        api.head = None
        self.assertEqual(self.helper.publish(api, self.files(), REVISION), "published")
        self.assertEqual(api.writes[-1][0:2], ("git/refs", "POST"))
        self.assertEqual(api.writes[-1][2]["ref"], "refs/heads/nas-deploy")

    def test_concurrent_non_fast_forward_failure_is_not_retried_with_force(self):
        api = FakeAPI()
        old_head = api.head
        api.conflicting_pointer = True
        with self.assertRaises(RuntimeError):
            self.helper.publish(api, self.files(), REVISION)
        self.assertEqual(api.head, old_head)
        updates = [payload for endpoint, _, payload in api.writes if endpoint == "git/refs/heads/nas-deploy"]
        self.assertEqual(len(updates), 1)
        self.assertIs(updates[0]["force"], False)


if __name__ == "__main__":
    unittest.main()
