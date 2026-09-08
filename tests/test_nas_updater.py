"""Offline deployment contract tests; never contact GitHub, Docker, or Portainer."""

import importlib.util
import copy
import io
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


UPDATER_PATH = Path(__file__).resolve().parents[1] / "deploy/nas-auto-update/updater.py"
REVISION = "a" * 40
PREVIOUS_REVISION = "d" * 40
REPOSITORY = "happyaspic-byte/Operix"
PREVIOUS_IMAGE_ID = "sha256:" + "d" * 64


def manifest():
    return {
        "schema": 1,
        "repository": REPOSITORY,
        "revision": REVISION,
        "image": "operix:github-" + REVISION,
        "image_id": "sha256:" + "b" * 64,
        "archive": "operix-image.tar.gz",
        "sha256": "c" * 64,
        "size": 1234,
        "run_id": "123456789",
    }


def stack_fixture():
    return {
        "Id": 19,
        "EndpointId": 3,
        "Name": "operix",
        "Type": 2,
        "GitConfig": None,
        "Env": [
            {"name": "POSTGRES_PASSWORD", "value": "test-only-database-password"},
            {"name": "SESSION_SECRET", "value": "test-only-session-secret"},
            {"name": "OPERIX_IMAGE", "value": "operix:github-" + PREVIOUS_REVISION},
            {"name": "OPERIX_DB_VOLUME", "value": "operix_database"},
            {"name": "OPERIX_UPLOAD_VOLUME", "value": "operix_uploads"},
            {"name": "OPERIX_SECURITY_VOLUME", "value": "operix_security"},
            {"name": "OPERIX_SCANNER_VOLUME", "value": "operix_scanner"},
            {"name": "OPERIX_PROXY_NETWORK", "value": "npm_default"},
            {"name": "APP_URL", "value": "https://operix.example.invalid"},
            {"name": "EXTRA_SETTING", "value": "preserve = $literal\\nvalue"},
        ],
    }


def compose_fixture():
    services = {
        "db": {
            "image": "postgres@sha256:" + "1" * 64,
            "volumes": ["database:/var/lib/postgresql/data"],
        },
        "scanner": {
            "image": "clamav/clamav@sha256:" + "2" * 64,
            "volumes": ["scanner:/var/lib/clamav"],
        },
        "migrate": {
            "image": "${OPERIX_IMAGE:-operix:nas-old}",
            "volumes": ["uploads:/app/storage/uploads", "security:/app/storage/security"],
            "command": ["node", "scripts/migrate.ts"],
            "restart": "no",
            "depends_on": {"db": {"condition": "service_healthy"}},
        },
        "web": {
            "image": "${OPERIX_IMAGE:-operix:nas-old}",
            "volumes": ["uploads:/app/storage/uploads", "security:/app/storage/security"],
            "depends_on": {"migrate": {"condition": "service_completed_successfully"}},
            "networks": {"default": {}, "proxy": {"aliases": ["operix-web"]}},
        },
        "worker": {
            "image": "${OPERIX_IMAGE:-operix:nas-old}",
            "volumes": ["uploads:/app/storage/uploads", "security:/app/storage/security"],
            "depends_on": {"migrate": {"condition": "service_completed_successfully"}},
        },
        "https": {
            "image": "nginx:stable-alpine",
            "volumes": ["https:/etc/nginx/conf.d:ro"],
            "depends_on": {"web": {"condition": "service_healthy"}},
        },
    }
    return json.dumps({
        "name": "operix",
        "services": services,
        "volumes": {
            "database": {"name": "${OPERIX_DB_VOLUME:-operix_database}"},
            "uploads": {"name": "${OPERIX_UPLOAD_VOLUME:-operix_uploads}"},
            "security": {"name": "${OPERIX_SECURITY_VOLUME:-operix_security}"},
            "scanner": {"name": "${OPERIX_SCANNER_VOLUME:-operix_scanner}"},
            "https": {"external": True, "name": "operix_https"},
        },
        "networks": {
            "default": {},
            "proxy": {"external": True, "name": "${OPERIX_PROXY_NETWORK:-npm_default}"},
        },
    }, indent=2) + "\n"


def ci_fixture():
    return {
        "main": {"sha": REVISION},
        "run": {
            "id": 123456789,
            "workflow_id": 350530126,
            "path": ".github/workflows/ci.yml",
            "head_sha": REVISION,
            "head_branch": "main",
            "event": "push",
            "status": "completed",
            "conclusion": "success",
            "repository": {"full_name": REPOSITORY},
            "head_repository": {"full_name": REPOSITORY},
        },
        "release": {
            "tag_name": "deploy-" + REVISION,
            "target_commitish": REVISION,
            "draft": False,
            "prerelease": False,
            "immutable": True,
            "assets": [{
                "id": 321,
                "name": "operix-image.tar.gz",
                "size": 1234,
                "state": "uploaded",
                "browser_download_url": "https://github.com/" + REPOSITORY
                + "/releases/download/deploy-" + REVISION + "/operix-image.tar.gz",
            }],
        },
        "gitref": {
            "ref": "refs/tags/deploy-" + REVISION,
            "object": {"type": "commit", "sha": REVISION},
        },
    }


def container_fixture():
    result = {}
    for index, name in enumerate(("db", "scanner", "migrate", "web", "worker", "https"), 1):
        app = name in ("migrate", "web", "worker")
        image = PREVIOUS_IMAGE_ID if app else "sha256:" + str(index) * 64
        mounts = {
            "db": [("operix_database", "/var/lib/postgresql/data")],
            "scanner": [("operix_scanner", "/var/lib/clamav")],
            "migrate": [("operix_uploads", "/app/storage/uploads"),
                        ("operix_security", "/app/storage/security")],
            "web": [("operix_uploads", "/app/storage/uploads"),
                    ("operix_security", "/app/storage/security")],
            "worker": [("operix_uploads", "/app/storage/uploads"),
                       ("operix_security", "/app/storage/security")],
            "https": [("operix_https", "/etc/nginx/conf.d")],
        }[name]
        result[name] = {
            "Id": str(index) * 64,
            "Name": "/operix-" + name + "-1",
            "Image": image,
            "Config": {
                "Image": "operix:github-" + PREVIOUS_REVISION if app else image,
                "Labels": {
                    "com.docker.compose.project": "operix",
                    "com.docker.compose.service": name,
                },
            },
            "State": {
                "Status": "exited" if name == "migrate" else "running",
                "Running": name != "migrate",
                "ExitCode": 0,
                "Health": {"Status": "healthy"},
            },
            "Mounts": [{"Type": "volume", "Name": volume, "Destination": destination,
                        "RW": name != "https"} for volume, destination in mounts],
            "NetworkSettings": {"Networks": {"operix_default": {"NetworkID": "network-1"}}},
        }
    result["web"]["NetworkSettings"]["Networks"]["npm_default"] = {"NetworkID": "network-2"}
    return result


def config_fixture():
    return {
        "portainer_url": "http://portainer:9000",
        "repository": REPOSITORY,
        "workflow_id": 350530126,
        "endpoint_id": 3,
        "stack_id": 19,
        "stack_name": "operix",
        "poll_seconds": 60,
        "health_url": "https://operix.roobicom.duckdns.org/api/health",
    }


def make_harness(module, state_dir, *, fail_health=False, fail_rollback=False,
                 fail_backup=False, fail_main=False):
    """Replace only remote I/O; keep the updater's transaction and disk state real."""
    class OfflineUpdater(module.Updater):
        def __init__(self):
            super().__init__(config_fixture(), state_dir, "test-only-portainer-key")
            self.events = []
            self.puts = []
            self.live_stack = stack_fixture()
            self.live_compose = compose_fixture()
            self.live_containers = container_fixture()

        def fetch_manifest(self):
            self.events.append("fetch_manifest")
            return manifest()

        def verify_release(self, candidate):
            self.events.append("verify_release")
            return ci_fixture()["release"]["assets"][0]

        def download_image(self, candidate, asset):
            self.events.append("download_image")
            archive = Path(state_dir) / "operix-image.tar.gz"
            archive.write_bytes(b"offline image fixture")
            return archive

        def load_image(self, path, candidate):
            self.events.append("load_image")
            if not path.is_file():
                raise AssertionError("image was not downloaded before loading")

        def get_stack(self):
            self.events.append("get_stack")
            return copy.deepcopy(self.live_stack), self.live_compose

        def inspect_containers(self):
            self.events.append("inspect_containers")
            return copy.deepcopy(self.live_containers)

        def backup_database(self, containers, backupdir):
            self.events.append("backup_database")
            if fail_backup:
                raise module.UpdateError("offline database backup failure")
            backupdir = Path(backupdir)
            backupdir.mkdir(parents=True, exist_ok=True)
            (backupdir / "database.dump").write_bytes(b"offline database fixture")

        def put_stack(self, compose, env):
            self.events.append("put_stack")
            state = json.loads((Path(state_dir) / "state.json").read_text())
            if not state.get("pending"):
                raise AssertionError("deployment must persist recovery state before PUT")
            self.puts.append((compose, copy.deepcopy(env)))
            self.live_compose = compose
            self.live_stack["Env"] = copy.deepcopy(env)
            image = next(pair["value"] for pair in env if pair["name"] == "OPERIX_IMAGE")
            image_id = manifest()["image_id"] if image == manifest()["image"] else PREVIOUS_IMAGE_ID
            for name in ("migrate", "web", "worker"):
                self.live_containers[name]["Image"] = image_id

        def wait_healthy(self, candidate, before):
            new_image = candidate["image_id"] == manifest()["image_id"]
            self.events.append("wait_new" if new_image else "wait_previous")
            if (new_image and fail_health) or (not new_image and fail_rollback):
                raise module.UpdateError("offline replacement health failure")

        def verify_main(self, candidate):
            self.events.append("verify_main")
            if fail_main:
                raise module.UpdateError("main advanced before deployment")

    return OfflineUpdater()


class UpdaterContracts(unittest.TestCase):
    def setUp(self):
        self.assertTrue(UPDATER_PATH.is_file(), "NAS updater implementation is missing")
        spec = importlib.util.spec_from_file_location("operix_nas_updater_test", UPDATER_PATH)
        self.updater = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.updater
        spec.loader.exec_module(self.updater)

    def test_rejects_manifest_from_another_repository(self):
        candidate = manifest()
        candidate["repository"] = "attacker/Operix"
        with self.assertRaises(self.updater.UpdateError):
            self.updater.validate_manifest(candidate)

    def test_accepts_complete_manifest_without_mutating_it(self):
        candidate = manifest()
        original = copy.deepcopy(candidate)
        self.assertEqual(self.updater.validate_manifest(candidate), original)
        self.assertEqual(candidate, original)

    def test_rejects_invalid_manifest_identity_and_archive_metadata(self):
        invalid = [
            ("schema", 2),
            ("schema", True),
            ("revision", "a" * 39),
            ("revision", "g" * 40),
            ("image", "operix:latest"),
            ("image", "operix:github-" + "d" * 40),
            ("image_id", "sha256:" + "b" * 63),
            ("archive", "../../credentials"),
            ("archive", "https://attacker.invalid/image.tar.gz"),
            ("sha256", "c" * 63),
            ("sha256", "z" * 64),
            ("size", 0),
            ("size", -1),
            ("size", True),
            ("size", "1234"),
            ("size", 1 << 60),
            ("run_id", "../123456789"),
            ("run_id", ""),
        ]
        for field, value in invalid:
            with self.subTest(field=field, value=value):
                candidate = manifest()
                candidate[field] = value
                with self.assertRaises(self.updater.UpdateError):
                    self.updater.validate_manifest(candidate)

    def test_rejects_manifest_with_missing_required_fields(self):
        for field in manifest():
            with self.subTest(field=field):
                candidate = manifest()
                del candidate[field]
                with self.assertRaises(self.updater.UpdateError):
                    self.updater.validate_manifest(candidate)

    def test_accepts_matching_successful_main_workflow_and_release(self):
        self.assertIsNone(self.updater.validate_ci(manifest(), **ci_fixture()))

    def test_rejects_untrusted_or_unsuccessful_workflow(self):
        invalid = [
            ("workflow_id", 350530127),
            ("id", 123456790),
            ("head_sha", "d" * 40),
            ("head_branch", "feature/unsafe"),
            ("event", "pull_request"),
            ("status", "in_progress"),
            ("conclusion", "failure"),
            ("conclusion", "cancelled"),
            ("repository", {"full_name": "attacker/Operix"}),
        ]
        for field, value in invalid:
            with self.subTest(field=field, value=value):
                inputs = ci_fixture()
                inputs["run"][field] = value
                with self.assertRaises(self.updater.UpdateError):
                    self.updater.validate_ci(manifest(), **inputs)

    def test_rejects_obsolete_main_or_retargeted_release(self):
        invalid = [
            ("main", "sha", "d" * 40),
            ("release", "tag_name", "deploy-" + "d" * 40),
            ("release", "draft", True),
            ("release", "immutable", False),
            ("gitref", "object", {"type": "commit", "sha": "d" * 40}),
        ]
        for source, field, value in invalid:
            with self.subTest(source=source, field=field):
                inputs = ci_fixture()
                inputs[source][field] = value
                with self.assertRaises(self.updater.UpdateError):
                    self.updater.validate_ci(manifest(), **inputs)

    def test_preserves_live_compose_and_every_non_image_environment_value(self):
        stack = stack_fixture()
        original = copy.deepcopy(stack)
        compose = compose_fixture()
        next_compose, next_env = self.updater.prepare_update(stack, compose, manifest())
        self.assertEqual(next_compose, compose)
        expected_env = copy.deepcopy(original["Env"])
        expected_env[2]["value"] = "operix:github-" + REVISION
        self.assertEqual(next_env, expected_env)
        self.assertEqual(stack, original)

    def test_rejects_a_different_stack_or_endpoint(self):
        for field, value in [("Id", 20), ("EndpointId", 4), ("Name", "another-app")]:
            with self.subTest(field=field):
                stack = stack_fixture()
                stack[field] = value
                with self.assertRaises(self.updater.UpdateError):
                    self.updater.prepare_update(stack, compose_fixture(), manifest())

    def test_rejects_ambiguous_duplicate_environment_keys(self):
        stack = stack_fixture()
        stack["Env"].append({"name": "OPERIX_IMAGE", "value": "operix:unexpected"})
        with self.assertRaises(self.updater.UpdateError):
            self.updater.prepare_update(stack, compose_fixture(), manifest())

    def test_accepts_successful_docker_image_load_stream(self):
        stream = io.BytesIO(b'{"stream":"Loading layer...\\n"}\n'
                            b'{"stream":"Loaded image: operix:github-test\\n"}\n')
        self.assertIsNone(self.updater.check_load_stream(stream))

    def test_rejects_docker_load_errors_even_in_a_successful_http_response(self):
        for error in [{"error": "archive is invalid"},
                      {"errorDetail": {"message": "no space left on device"}}]:
            with self.subTest(error=error):
                body = b'{"stream":"Loading layer...\\n"}\n' + json.dumps(error).encode() + b"\n"
                with self.assertRaises(self.updater.UpdateError):
                    self.updater.check_load_stream(io.BytesIO(body))

    def test_rejects_malformed_docker_load_stream(self):
        with self.assertRaises(self.updater.UpdateError):
            self.updater.check_load_stream(io.BytesIO(b"upstream proxy failure\n"))

    def test_successful_update_backs_up_before_put_and_records_applied_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory))
            self.assertEqual(updater.run_once(), "applied")
            self.assertEqual(len(updater.puts), 1)
            compose, env = updater.puts[0]
            expected_env = stack_fixture()["Env"]
            expected_env[2]["value"] = "operix:github-" + REVISION
            self.assertEqual(compose, compose_fixture())
            self.assertEqual(env, expected_env)
            self.assertLess(updater.events.index("backup_database"), updater.events.index("put_stack"))
            self.assertLess(updater.events.index("verify_main"), updater.events.index("put_stack"))
            self.assertLess(updater.events.index("put_stack"), updater.events.index("wait_new"))
            state_path = Path(directory) / "state.json"
            state = json.loads(state_path.read_text())
            self.assertEqual(state["applied_sha"], REVISION)
            self.assertIsNone(state.get("pending"))
            self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
            snapshots = list((Path(directory) / "backups").rglob("snapshot.json"))
            self.assertEqual(len(snapshots), 1)
            self.assertEqual(snapshots[0].stat().st_mode & 0o777, 0o600)
            snapshot = json.loads(snapshots[0].read_text())
            self.assertEqual(snapshot["stack"]["Env"], stack_fixture()["Env"])
            self.assertEqual(snapshot["compose"], compose_fixture())

    def test_failed_or_already_applied_revision_skips_release_rest_and_mutations(self):
        for key in ("failed_sha", "applied_sha"):
            with self.subTest(state_key=key), tempfile.TemporaryDirectory() as directory:
                (Path(directory) / "state.json").write_text(json.dumps({key: REVISION}))
                updater = make_harness(self.updater, Path(directory))
                self.assertEqual(updater.run_once(), "skipped")
                self.assertEqual(updater.events, ["fetch_manifest"])
                self.assertEqual(updater.puts, [])

    def test_backup_failure_never_replaces_running_stack(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory), fail_backup=True)
            self.assertEqual(updater.run_once(), "failed")
            self.assertEqual(updater.puts, [])
            state = json.loads((Path(directory) / "state.json").read_text())
            self.assertEqual(state["failed_sha"], REVISION)
            self.assertIsNone(state.get("pending"))

    def test_main_advance_before_put_never_replaces_running_stack(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory), fail_main=True)
            self.assertEqual(updater.run_once(), "failed")
            self.assertEqual(updater.puts, [])
            state = json.loads((Path(directory) / "state.json").read_text())
            self.assertEqual(state["failed_sha"], REVISION)

    def test_unhealthy_replacement_restores_full_previous_stack_and_skips_failed_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory), fail_health=True)
            self.assertEqual(updater.run_once(), "rolled_back")
            self.assertEqual(len(updater.puts), 2)
            self.assertEqual(updater.puts[-1], (compose_fixture(), stack_fixture()["Env"]))
            self.assertIn("wait_previous", updater.events)
            state = json.loads((Path(directory) / "state.json").read_text())
            self.assertEqual(state["failed_sha"], REVISION)
            self.assertNotEqual(state.get("applied_sha"), REVISION)
            self.assertIsNone(state.get("pending"))
            self.assertFalse(state.get("blocked"))
            restarted = make_harness(self.updater, Path(directory))
            self.assertEqual(restarted.run_once(), "skipped")
            self.assertEqual(restarted.events, ["fetch_manifest"])

    def test_failed_rollback_blocks_later_deployments(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory), fail_health=True, fail_rollback=True)
            self.assertEqual(updater.run_once(), "blocked")
            state = json.loads((Path(directory) / "state.json").read_text())
            self.assertTrue(state["blocked"])
            restarted = make_harness(self.updater, Path(directory))
            self.assertEqual(restarted.run_once(), "blocked")
            self.assertEqual(restarted.events, [])
            self.assertEqual(restarted.puts, [])

    def test_interrupted_deployment_recovers_before_fetching_another_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            snapshot_relative = "backups/1757332800000000000-aaaaaaaaaaaa-01234567/snapshot.json"
            snapshot_path = Path(directory) / snapshot_relative
            snapshot_path.parent.mkdir(parents=True)
            new_env = stack_fixture()["Env"]
            new_env[2]["value"] = manifest()["image"]
            snapshot_path.write_text(json.dumps({
                "manifest": manifest(),
                "stack": stack_fixture(),
                "compose": compose_fixture(),
                "containers": container_fixture(),
                "previous_image": PREVIOUS_IMAGE_ID,
                "new_env": new_env,
            }))
            (Path(directory) / "state.json").write_text(json.dumps({
                "applied_sha": PREVIOUS_REVISION,
                "failed_sha": None,
                "blocked": False,
                "pending": {"revision": REVISION, "snapshot": snapshot_relative},
            }))
            updater = make_harness(self.updater, Path(directory))
            (Path(directory) / "operix-image.tar.gz").write_bytes(b"interrupted download")
            self.assertEqual(updater.run_once(), "rolled_back")
            self.assertNotIn("fetch_manifest", updater.events)
            self.assertEqual(updater.puts, [(compose_fixture(), stack_fixture()["Env"])])
            self.assertIn("wait_previous", updater.events)
            state = json.loads((Path(directory) / "state.json").read_text())
            self.assertEqual(state["applied_sha"], PREVIOUS_REVISION)
            self.assertEqual(state["failed_sha"], REVISION)
            self.assertIsNone(state.get("pending"))
            self.assertFalse((Path(directory) / "operix-image.tar.gz").exists())

    def test_rejects_image_variable_used_outside_the_three_app_images(self):
        compose = json.loads(compose_fixture())
        compose["services"]["db"]["environment"] = {"DO_NOT_CHANGE": "${OPERIX_IMAGE}"}
        with self.assertRaises(self.updater.UpdateError):
            self.updater.prepare_update(stack_fixture(), json.dumps(compose), manifest())

    def test_download_rejects_wrong_size_or_checksum_and_removes_partial_file(self):
        for expected, checksum in [(5, None), (3, "a" * 64)]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                updater = make_harness(self.updater, Path(directory))
                target = Path(directory) / "download"
                with self.assertRaises(self.updater.UpdateError):
                    updater._save_stream(io.BytesIO(b"abc"), target, 100, expected, checksum)
                self.assertFalse(target.exists())
                self.assertFalse(target.with_name("download.part").exists())

    def test_rate_limit_backoff_does_not_poison_revision_or_call_rest_again(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory))
            updater.verify_release = mock.Mock(side_effect=self.updater.RateLimited(self.updater.time.time() + 600))
            self.assertEqual(updater.run_once(), "backoff")
            state = json.loads((Path(directory) / "state.json").read_text())
            self.assertIsNone(state.get("failed_sha"))
            updater.events.clear()
            self.assertEqual(updater.run_once(), "backoff")
            self.assertEqual(updater.events, [])
            self.assertEqual(updater.puts, [])

    def test_changed_infrastructure_or_mount_fails_health_without_waiting(self):
        for change in ("container", "mount"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                updater = make_harness(self.updater, Path(directory))
                before = container_fixture()
                if change == "container":
                    updater.live_containers["db"]["Id"] = "f" * 64
                else:
                    updater.live_containers["web"]["Mounts"][0]["Name"] = "wrong_volume"
                with self.assertRaises(self.updater.UpdateError), mock.patch.object(self.updater.time, "sleep") as sleep:
                    self.updater.Updater.wait_healthy(updater, manifest(), before)
                sleep.assert_not_called()

    def test_custom_https_health_uses_certificate_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            config = config_fixture()
            config["health_url"] = "https://172.30.1.99:9010/api/health"
            config["health_ca"] = "/config/health-ca.pem"
            updater = self.updater.Updater(config, directory, "test-only-key")
            with mock.patch.object(self.updater.ssl, "create_default_context") as context:
                with mock.patch.object(self.updater.urllib.request, "build_opener") as opener:
                    updater._open(config["health_url"])
                context.assert_called_once_with(cafile="/config/health-ca.pem")
                self.assertTrue(any(isinstance(arg, self.updater.urllib.request.HTTPSHandler)
                                    for arg in opener.call_args.args))

    def test_verified_prerelease_is_a_valid_deployment_release(self):
        inputs = ci_fixture()
        inputs["release"]["prerelease"] = True
        self.assertIsNone(self.updater.validate_ci(manifest(), **inputs))

    def test_first_deployment_allows_removed_one_shot_migrate_container(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory))
            del updater.live_containers["migrate"]
            original_put = updater.put_stack

            def create_migration(compose, env):
                updater.live_containers.setdefault("migrate", container_fixture()["migrate"])
                original_put(compose, env)

            updater.put_stack = create_migration
            self.assertEqual(updater.run_once(), "applied")

    def test_pending_ci_can_complete_without_changing_manifest_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory))
            inputs = ci_fixture()
            inputs["run"].update(status="in_progress", conclusion=None)

            def check_ci(candidate):
                self.updater.validate_ci(candidate, **inputs)
                return inputs["release"]["assets"][0]

            updater.verify_release = check_ci
            self.assertEqual(updater.run_once(), "backoff")
            self.assertIsNone(updater.state.get("failed_sha"))
            inputs["run"].update(status="completed", conclusion="success")
            updater.state["backoff_until"] = 0
            updater.save_state()
            self.assertEqual(updater.run_once(), "applied")

    def test_temporary_download_failure_can_retry_the_same_release(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory))
            download = updater.download_image
            updater.download_image = mock.Mock(side_effect=OSError("test-only network interruption"))
            self.assertEqual(updater.run_once(), "backoff")
            self.assertIsNone(updater.state.get("failed_sha"))
            updater.download_image = download
            updater.state["backoff_until"] = 0
            updater.save_state()
            self.assertEqual(updater.run_once(), "applied")

    def test_direct_health_route_keeps_certificate_hostname(self):
        with tempfile.TemporaryDirectory() as directory:
            config = config_fixture()
            config.update(health_url="https://172.30.1.99:9010/api/health",
                          health_ca="/config/health-ca.pem", health_connect_host="https", health_connect_port=443)
            updater = self.updater.Updater(config, directory, "test-only-key")
            with mock.patch.object(self.updater.ssl, "create_default_context") as context:
                with mock.patch.object(self.updater.socket, "create_connection") as connect:
                    with mock.patch.object(self.updater.http.client, "HTTPSConnection") as https:
                        https.return_value.getresponse.return_value.status = 200
                        https.return_value.getresponse.return_value.read.return_value = b'{"status":"ok"}'
                        self.assertEqual(updater.health_status(), {"status": "ok"})
            connect.assert_called_once_with(("https", 443), timeout=15)
            context.return_value.wrap_socket.assert_called_once_with(connect.return_value, server_hostname="172.30.1.99")
            self.assertEqual(https.call_args.args, ("172.30.1.99", 9010))

    def test_host_network_allows_only_expected_loopback_portainer(self):
        with tempfile.TemporaryDirectory() as directory:
            config = config_fixture()
            config["portainer_url"] = "http://127.0.0.1:9000"
            self.updater.Updater(config, directory, "test-only-key")
            config["portainer_url"] = "https://attacker.invalid"
            with self.assertRaises(self.updater.UpdateError):
                self.updater.Updater(config, directory, "test-only-key")

    def test_load_requires_manifest_image_id_and_uses_binary_content_length(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory))
            path = Path(directory) / "operix-image.tar.gz"
            path.write_bytes(b"compressed fixture")
            requests = []

            def fake_open(url, method, body, headers, **kwargs):
                requests.append((url, method, body.read(), headers, kwargs))
                return io.BytesIO(b'{"stream":"Loaded image: fixture\\n"}\n')

            updater._open = fake_open
            updater.docker = lambda url: {"Id": PREVIOUS_IMAGE_ID, "Os": "linux", "Architecture": "amd64"}
            with self.assertRaises(self.updater.UpdateError):
                self.updater.Updater.load_image(updater, path, manifest())
            self.assertEqual(requests[0][1:3], ("POST", b"compressed fixture"))
            self.assertEqual(requests[0][3]["Content-Length"], "18")
            self.assertEqual(requests[0][3]["Content-Type"], "application/x-tar")
            self.assertTrue(requests[0][4]["portainer"])

    def test_actual_health_requires_new_migration_and_preserves_its_mounts(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory))
            before = container_fixture()
            del before["migrate"]
            for service in ("migrate", "web", "worker"):
                updater.live_containers[service]["Image"] = manifest()["image_id"]
            updater.health_status = lambda: {"status": "ok"}
            self.updater.Updater.wait_healthy(updater, manifest(), before)
            updater.live_containers["migrate"]["Mounts"][0]["Name"] = "wrong-volume"
            with self.assertRaises(self.updater.UpdateError):
                self.updater.Updater.wait_healthy(updater, manifest(), before)

    def test_backup_retention_failure_does_not_invalidate_a_verified_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            updater = make_harness(self.updater, Path(directory))
            updater._retain_backups = mock.Mock(side_effect=OSError("offline cleanup failure"))
            self.assertEqual(updater.run_once(), "applied")
            self.assertEqual(updater.state["applied_sha"], REVISION)
            self.assertIsNone(updater.state.get("failed_sha"))


if __name__ == "__main__":
    unittest.main()
