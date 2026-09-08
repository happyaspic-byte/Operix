#!/usr/bin/env python3
"""Apply verified Operix releases to the existing NAS stack using Portainer.

Only Python's standard library is required. State and database backups are private;
logs contain fixed diagnostic codes, never HTTP bodies, Compose, or credentials.
"""

import argparse
import copy
import email.utils
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


REPOSITORY = "happyaspic-byte/Operix"
WORKFLOW_ID = 350530126
STACK_ID = 19
ENDPOINT_ID = 3
STACK_NAME = "operix"
HEALTH_URL = "https://operix.roobicom.duckdns.org/api/health"
ARCHIVE = "operix-image.tar.gz"
MAX_ARCHIVE = 2_000_000_000
SERVICES = frozenset(("db", "scanner", "migrate", "web", "worker", "https"))
APP_SERVICES = frozenset(("migrate", "web", "worker"))
INFRA_SERVICES = SERVICES - APP_SERVICES
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
IMAGE_VARIABLE = re.compile(r"\$\{OPERIX_IMAGE(?::-[^{}]+)?\}\Z")


class UpdateError(Exception):
    """A fixed, safe diagnostic code; underlying exceptions are never logged."""


class Retryable(UpdateError):
    """A pre-deployment condition that can change without a new revision."""

    def __init__(self, code, retry_seconds=300):
        super().__init__(code)
        self.retry_seconds = retry_seconds


class RateLimited(UpdateError):
    def __init__(self, retry_at):
        super().__init__("github_rate_limited")
        self.retry_at = retry_at


def require(condition, code):
    if not condition:
        raise UpdateError(code)


def validate_manifest(manifest):
    require(isinstance(manifest, dict), "invalid_manifest")
    revision = manifest.get("revision")
    require(isinstance(revision, str) and SHA.fullmatch(revision), "invalid_revision")
    require(type(manifest.get("schema")) is int and manifest["schema"] == 1, "invalid_schema")
    require(manifest.get("repository") == REPOSITORY, "invalid_repository")
    require(manifest.get("image") == "operix:github-" + revision, "invalid_image")
    require(isinstance(manifest.get("image_id"), str) and DIGEST.fullmatch(manifest["image_id"]), "invalid_image_id")
    require(manifest.get("archive") == ARCHIVE, "invalid_archive")
    require(isinstance(manifest.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", manifest["sha256"]), "invalid_checksum")
    require(type(manifest.get("size")) is int and 0 < manifest["size"] <= MAX_ARCHIVE, "invalid_size")
    require(isinstance(manifest.get("run_id"), str) and re.fullmatch(r"[1-9][0-9]{0,19}", manifest["run_id"]), "invalid_run_id")
    return manifest


def validate_ci(manifest, main, run, release, gitref):
    validate_manifest(manifest)
    revision = manifest["revision"]
    if not isinstance(main, dict) or main.get("sha") != revision:
        raise Retryable("main_moved")
    require(isinstance(run, dict), "invalid_ci_run")
    require(str(run.get("id")) == manifest["run_id"] and run.get("workflow_id") == WORKFLOW_ID, "wrong_ci_run")
    require(run.get("event") in ("push", "workflow_dispatch"), "wrong_ci_event")
    require(run.get("head_branch") == "main" and run.get("head_sha") == revision, "wrong_ci_revision")
    require(run.get("repository", {}).get("full_name") == REPOSITORY, "wrong_ci_repository")
    if run.get("head_repository") is not None:
        require(run["head_repository"].get("full_name") == REPOSITORY, "wrong_ci_repository")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise Retryable("ci_not_successful", retry_seconds=60)
    tag = "deploy-" + revision
    require(isinstance(release, dict) and release.get("tag_name") == tag, "wrong_release")
    require(release.get("draft") is False and release.get("immutable") is True, "release_not_immutable")
    require(isinstance(gitref, dict) and gitref.get("ref") == "refs/tags/" + tag, "wrong_release_ref")
    require(gitref.get("object", {}).get("type") == "commit" and gitref["object"].get("sha") == revision, "wrong_release_revision")


def prepare_update(stack, compose_text, manifest):
    validate_manifest(manifest)
    require(isinstance(stack, dict), "invalid_stack")
    require(stack.get("Id") == STACK_ID and stack.get("EndpointId") == ENDPOINT_ID
            and stack.get("Name") == STACK_NAME and stack.get("Type") == 2
            and stack.get("GitConfig") is None, "wrong_stack")
    try:
        compose = json.loads(compose_text)
    except (TypeError, ValueError):
        raise UpdateError("compose_must_be_json") from None
    require(isinstance(compose, dict) and compose.get("name", STACK_NAME) == STACK_NAME, "wrong_compose_project")
    services = compose.get("services")
    require(isinstance(services, dict) and set(services) == SERVICES, "unexpected_services")
    stripped = copy.deepcopy(compose)
    for name in APP_SERVICES:
        service = services[name]
        require(isinstance(service, dict) and isinstance(service.get("image"), str)
                and IMAGE_VARIABLE.fullmatch(service["image"]), "unsupported_app_image")
        del stripped["services"][name]["image"]
    require("OPERIX_IMAGE" not in json.dumps(stripped), "image_variable_has_other_uses")
    for name in ("web", "worker"):
        require(services[name].get("depends_on", {}).get("migrate", {}).get("condition")
                == "service_completed_successfully", "missing_migration_dependency")
    require(services["migrate"].get("volumes") == services["web"].get("volumes"), "unexpected_migration_mounts")
    env = stack.get("Env")
    require(isinstance(env, list), "invalid_stack_env")
    new_env = copy.deepcopy(env)
    seen = set()
    for pair in new_env:
        require(isinstance(pair, dict) and isinstance(pair.get("name"), str)
                and isinstance(pair.get("value"), str) and pair["name"] not in seen, "invalid_stack_env")
        seen.add(pair["name"])
        if pair["name"] == "OPERIX_IMAGE":
            pair["value"] = manifest["image"]
    if "OPERIX_IMAGE" not in seen:
        new_env.append({"name": "OPERIX_IMAGE", "value": manifest["image"]})
    return compose_text, new_env


def check_load_stream(stream):
    seen = False
    size = 0
    while True:
        line = stream.readline(65537)
        if not line:
            break
        size += len(line)
        require(len(line) <= 65536 and size <= 8_000_000, "invalid_load_response")
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except (TypeError, ValueError):
            raise UpdateError("invalid_load_response") from None
        require(isinstance(item, dict), "invalid_load_response")
        require(not item.get("error") and not item.get("errorDetail"), "image_load_failed")
        seen = True
    require(seen, "empty_load_response")


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, public):
        self.public = public

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        require(self.public and parsed.scheme == "https" and not parsed.username
                and (parsed.hostname == "github.com" or (parsed.hostname or "").endswith(".githubusercontent.com")),
                "redirect_rejected")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def private_write(path, value):
    """Atomic, fsynced private state; no incomplete pending transaction is visible."""
    path = Path(path)
    require(not path.is_symlink(), "unsafe_state_path")
    fd, temp = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, sort_keys=True, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def private_read(path):
    path = Path(path)
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= 16_000_000, "invalid_state_file")
    os.chmod(path, 0o600)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        raise UpdateError("invalid_state_file") from None


def mounts(container):
    return sorted(json.dumps({key: mount.get(key) for key in
                             ("Type", "Name", "Source", "Destination", "Driver", "Mode", "RW", "Propagation")}, sort_keys=True)
                  for mount in container.get("Mounts", []))


class Updater:
    def __init__(self, config, state_dir="/state", key=None):
        self.config = copy.deepcopy(config)
        for name, value in (("repository", REPOSITORY), ("workflow_id", WORKFLOW_ID),
                            ("endpoint_id", ENDPOINT_ID), ("stack_id", STACK_ID), ("stack_name", STACK_NAME)):
            require(config.get(name) == value, "wrong_updater_target")
        require(config.get("portainer_url") in ("http://portainer:9000", "http://127.0.0.1:9000"), "wrong_portainer_url")
        health = urllib.parse.urlsplit(config.get("health_url", ""))
        require(health.scheme == "https" and health.hostname and not health.username
                and not health.password and health.path == "/api/health" and not health.query
                and not health.fragment, "wrong_health_url")
        require(config.get("health_ca") in (None, "/config/health-ca.pem"), "wrong_health_ca")
        if config.get("health_connect_host") is not None or config.get("health_connect_port") is not None:
            require(isinstance(config.get("health_connect_host"), str)
                    and re.fullmatch(r"[a-zA-Z0-9.-]+", config["health_connect_host"])
                    and type(config.get("health_connect_port")) is int
                    and 0 < config["health_connect_port"] <= 65535, "wrong_health_connect_route")
        require(type(config.get("poll_seconds")) is int and 60 <= config["poll_seconds"] <= 3600, "invalid_poll_seconds")
        if key is None:
            key = Path("/config/api-key").read_text(encoding="utf-8").strip()
        require(isinstance(key, str) and key and "\r" not in key and "\n" not in key, "invalid_api_key")
        self.key = key
        self.state_dir = Path(state_dir)
        require(not self.state_dir.is_symlink(), "unsafe_state_path")
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.state_dir, 0o700)
        self.backups = self.state_dir / "backups"
        require(not self.backups.is_symlink(), "unsafe_state_path")
        self.backups.mkdir(mode=0o700, exist_ok=True)
        os.chmod(self.backups, 0o700)
        self.state_path = self.state_dir / "state.json"
        self.state = self._read_state()

    def _read_state(self):
        state = private_read(self.state_path) if self.state_path.exists() else {}
        require(isinstance(state, dict), "invalid_state_file")
        return state

    def save_state(self):
        private_write(self.state_path, self.state)

    @staticmethod
    def log(code):
        # Only call with application-owned literal codes, never exception text.
        print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), code, flush=True)

    def _open(self, url, method="GET", data=None, headers=None, timeout=60, portainer=False):
        request_headers = {"User-Agent": "Operix-NAS-Updater/1", "Cache-Control": "no-cache"}
        if headers:
            request_headers.update(headers)
        if portainer:
            request_headers["X-API-Key"] = self.key
        request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
        handlers = [urllib.request.ProxyHandler({}), SafeRedirect(not portainer)]
        if url == self.config["health_url"]:
            handlers.append(urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=self.config.get("health_ca"))))
        opener = urllib.request.build_opener(*handlers)
        try:
            return opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            if not portainer and urllib.parse.urlsplit(url).hostname in ("api.github.com", "raw.githubusercontent.com", "github.com") and error.code in (403, 429):
                retry_at = time.time() + 300
                raw_retry = error.headers.get("Retry-After", "")
                raw_reset = error.headers.get("X-RateLimit-Reset", "")
                try:
                    retry_at = max(retry_at, time.time() + int(raw_retry))
                except ValueError:
                    try:
                        retry_at = max(retry_at, email.utils.parsedate_to_datetime(raw_retry).timestamp())
                    except (ValueError, TypeError, OverflowError):
                        pass
                if raw_reset.isdigit():
                    retry_at = max(retry_at, int(raw_reset) + 5)
                error.close()
                raise RateLimited(min(retry_at, time.time() + 86400)) from None
            error.close()
            if error.code in (408, 425, 500, 502, 503, 504) or (not portainer and error.code == 404):
                raise Retryable("http_temporarily_unavailable") from None
            raise UpdateError("http_request_failed") from None
        except (OSError, ValueError, urllib.error.URLError):
            raise Retryable("network_request_failed") from None

    def _json(self, url, method="GET", payload=None, portainer=False, timeout=60):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if url.startswith("https://api.github.com/"):
            headers["Accept"] = "application/vnd.github+json"
            headers["X-GitHub-Api-Version"] = "2022-11-28"
        with self._open(url, method, data, headers, timeout, portainer) as response:
            raw = response.read(16_000_001)
        require(len(raw) <= 16_000_000, "response_too_large")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise UpdateError("invalid_json_response") from None

    def portainer(self, path, method="GET", payload=None, timeout=60):
        return self._json(self.config["portainer_url"] + "/api" + path, method, payload, True, timeout)

    def docker(self, path, method="GET", payload=None, timeout=60):
        return self.portainer(f"/endpoints/{ENDPOINT_ID}/docker" + path, method, payload, timeout)

    def github(self, path):
        return self._json("https://api.github.com/repos/" + REPOSITORY + path)

    def fetch_manifest(self):
        return self._json("https://raw.githubusercontent.com/" + REPOSITORY + "/nas-deploy/manifest.json")

    def verify_main(self, manifest):
        main = self.github("/commits/main")
        if not isinstance(main, dict) or main.get("sha") != manifest["revision"]:
            raise Retryable("main_moved")

    def verify_release(self, manifest):
        main = self.github("/commits/main")
        run = self.github("/actions/runs/" + manifest["run_id"])
        release = self.github("/releases/tags/deploy-" + manifest["revision"])
        gitref = self.github("/git/ref/tags/deploy-" + manifest["revision"])
        validate_ci(manifest, main, run, release, gitref)
        assets = release.get("assets")
        require(isinstance(assets, list), "invalid_release_assets")
        matches = [item for item in assets if isinstance(item, dict) and item.get("name") == ARCHIVE]
        require(len(matches) == 1 and matches[0].get("size") == manifest["size"], "wrong_release_asset")
        require(matches[0].get("state") == "uploaded", "incomplete_release_asset")
        return matches[0]

    def _save_stream(self, response, path, limit, expected=None, checksum=None):
        require(not path.is_symlink(), "unsafe_state_path")
        temp = path.with_name(path.name + ".part")
        require(not temp.is_symlink(), "unsafe_state_path")
        total = 0
        digest = hashlib.sha256()
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    require(total <= limit and (expected is None or total <= expected), "download_too_large")
                    output.write(chunk)
                    digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            require(total > 0 and (expected is None or total == expected), "download_size_mismatch")
            require(checksum is None or digest.hexdigest() == checksum, "download_checksum_mismatch")
            os.replace(temp, path)
        finally:
            if temp.exists():
                temp.unlink()

    def download_image(self, manifest, asset):
        # The public asset URL is derived from the verified revision, never supplied by the manifest.
        url = "https://github.com/" + REPOSITORY + "/releases/download/deploy-" + manifest["revision"] + "/" + ARCHIVE
        path = self.state_dir / ARCHIVE
        with self._open(url, timeout=180) as response:
            self._save_stream(response, path, MAX_ARCHIVE, manifest["size"], manifest["sha256"])
        return path

    def load_image(self, path, manifest):
        url = self.config["portainer_url"] + f"/api/endpoints/{ENDPOINT_ID}/docker/images/load?quiet=true"
        headers = {"Content-Type": "application/x-tar", "Content-Length": str(path.stat().st_size)}
        with path.open("rb") as body:
            with self._open(url, "POST", body, headers, timeout=900, portainer=True) as response:
                check_load_stream(response)
        image = self.docker("/images/" + urllib.parse.quote(manifest["image"], safe="") + "/json")
        require(image.get("Id") == manifest["image_id"] and image.get("Os") == "linux"
                and image.get("Architecture") == "amd64", "loaded_image_mismatch")

    def get_stack(self):
        stack = self.portainer(f"/stacks/{STACK_ID}")
        content = self.portainer(f"/stacks/{STACK_ID}/file")
        require(isinstance(content, dict) and isinstance(content.get("StackFileContent"), str), "invalid_stack_file")
        return stack, content["StackFileContent"]

    def put_stack(self, compose, env):
        self.portainer(f"/stacks/{STACK_ID}?endpointId={ENDPOINT_ID}", "PUT", {
            "StackFileContent": compose,
            "Env": env,
            "RepullImageAndRedeploy": False,
        }, timeout=900)

    def inspect_containers(self):
        filters = json.dumps({"label": ["com.docker.compose.project=" + STACK_NAME]}, separators=(",", ":"))
        listed = self.docker("/containers/json?" + urllib.parse.urlencode({"all": "true", "filters": filters}))
        require(isinstance(listed, list), "invalid_containers")
        containers = {}
        for item in listed:
            labels = item.get("Labels", {})
            service = labels.get("com.docker.compose.service")
            require(labels.get("com.docker.compose.project") == STACK_NAME and service in SERVICES
                    and service not in containers and labels.get("com.docker.compose.oneoff", "False").lower() == "false", "unexpected_containers")
            identifier = item.get("Id", "")
            require(isinstance(identifier, str) and re.fullmatch(r"[0-9a-f]{64}", identifier), "invalid_container_id")
            containers[service] = self.docker("/containers/" + identifier + "/json")
        require(SERVICES - {"migrate"} <= set(containers) <= SERVICES, "missing_containers")
        return containers

    def _exec(self, container_id, command):
        created = self.docker("/containers/" + urllib.parse.quote(container_id, safe="") + "/exec", "POST", {
            "AttachStdout": False, "AttachStderr": False, "Tty": False, "Cmd": command,
        })
        identifier = created.get("Id", "")
        require(isinstance(identifier, str) and re.fullmatch(r"[0-9a-f]{64}", identifier), "invalid_exec_id")
        self.docker("/exec/" + identifier + "/start", "POST", {"Detach": True, "Tty": False})
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            status = self.docker("/exec/" + identifier + "/json")
            if status.get("Running") is False:
                require(status.get("ExitCode") == 0, "database_backup_command_failed")
                return
            time.sleep(1)
        raise UpdateError("database_backup_timed_out")

    def backup_database(self, containers, backup_dir):
        container_id = containers["db"]["Id"]
        name = "operix-auto-update-" + uuid.uuid4().hex + ".dump"
        remote = "/tmp/" + name
        self._exec(container_id, ["pg_dump", "-U", "operix", "-d", "operix", "-Fc", "-f", remote])
        try:
            url = self.config["portainer_url"] + f"/api/endpoints/{ENDPOINT_ID}/docker/containers/" + urllib.parse.quote(container_id, safe="") + "/archive?" + urllib.parse.urlencode({"path": remote})
            path = backup_dir / "database.dump.tar"
            with self._open(url, timeout=180, portainer=True) as response:
                self._save_stream(response, path, MAX_ARCHIVE)
            with tarfile.open(path, "r:") as archive:
                members = archive.getmembers()
                require(len(members) == 1 and members[0].isfile() and members[0].name == name
                        and members[0].size > 5, "invalid_database_backup")
                with archive.extractfile(members[0]) as dump:
                    require(dump.read(5) == b"PGDMP", "invalid_database_backup")
        finally:
            try:
                self._exec(container_id, ["rm", "-f", "--", remote])
            except Exception:
                self.log("database_backup_temp_cleanup_failed")

    def health_status(self):
        if not self.config.get("health_connect_host"):
            return self._json(self.config["health_url"], timeout=10)
        parsed = urllib.parse.urlsplit(self.config["health_url"])
        context = ssl.create_default_context(cafile=self.config.get("health_ca"))
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=15, context=context)
        raw_socket = None
        try:
            raw_socket = socket.create_connection((self.config["health_connect_host"], self.config["health_connect_port"]), timeout=15)
            # Route directly on the bridge while retaining the certificate name and HTTP Host.
            connection.sock = context.wrap_socket(raw_socket, server_hostname=parsed.hostname)
            connection.request("GET", parsed.path, headers={"Cache-Control": "no-cache"})
            response = connection.getresponse()
            require(response.status == 200, "external_health_failed")
            body = response.read(65537)
            require(len(body) <= 65536, "invalid_health_response")
            return json.loads(body)
        except (OSError, ValueError, http.client.HTTPException):
            raise UpdateError("external_health_failed") from None
        finally:
            connection.close()
            if raw_socket is not None:
                raw_socket.close()

    def wait_healthy(self, manifest, before):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                current = self.inspect_containers()
                require(set(current) == SERVICES, "migration_not_created")
                require(all(current[name].get("Id") == before[name].get("Id") for name in INFRA_SERVICES), "infrastructure_changed")
                require(all(mounts(current[name]) == mounts(before[name]) for name in before), "mounts_changed")
                if "migrate" not in before:
                    require(mounts(current["migrate"]) == mounts(before["web"]), "mounts_changed")
                require(all(current[name].get("Image") == manifest["image_id"] for name in APP_SERVICES), "app_image_mismatch")
                migration = current["migrate"].get("State", {})
                require(migration.get("Status") == "exited" and migration.get("ExitCode") == 0, "migration_not_successful")
                require(current["web"].get("State", {}).get("Health", {}).get("Status") == "healthy", "web_not_healthy")
                require(all(current[name].get("State", {}).get("Running") is True for name in SERVICES - {"migrate"}), "service_not_running")
                health = self.health_status()
                require(isinstance(health, dict) and health.get("status") == "ok", "external_health_failed")
                return
            except UpdateError as error:
                if str(error) in ("infrastructure_changed", "mounts_changed"):
                    raise
                time.sleep(5)
        raise UpdateError("deployment_health_timed_out")

    def _snapshot_path(self, relative):
        require(isinstance(relative, str) and re.fullmatch(r"backups/[0-9]+-[0-9a-f]{12}-[0-9a-f]{8}/snapshot\.json", relative), "invalid_pending_transaction")
        path = self.state_dir / relative
        require(not path.parent.is_symlink(), "unsafe_state_path")
        return path

    def recover(self):
        pending = self.state.get("pending")
        try:
            require(isinstance(pending, dict) and isinstance(pending.get("revision"), str)
                    and SHA.fullmatch(pending["revision"]), "invalid_pending_transaction")
            snapshot = private_read(self._snapshot_path(pending.get("snapshot")))
            old_stack = snapshot["stack"]
            old_compose = snapshot["compose"]
            # Refuse to overwrite an operator's intervening edit during crash recovery.
            current, current_compose = self.get_stack()
            prepare_update(current, current_compose, snapshot["manifest"])
            require(current_compose == old_compose and current.get("Env") in
                    (old_stack["Env"], snapshot["new_env"]), "stack_changed_during_recovery")
            self.put_stack(old_compose, old_stack["Env"])
            self.wait_healthy({"image_id": snapshot["previous_image"]}, snapshot["containers"])
            self.state["failed_sha"] = pending["revision"]
            self.state["pending"] = None
            self.state["blocked"] = False
            self.save_state()
            self.log("image_rollback_succeeded_database_not_rolled_back")
            return "rolled_back"
        except Exception as error:
            self.state["blocked"] = {"reason": "rollback_failed", "requires_operator": True}
            self.state["last_error_code"] = str(error) if isinstance(error, UpdateError) else "unexpected_error"
            self.save_state()
            self.log("BLOCKED_rollback_failed_requires_operator_database_not_rolled_back")
            return "blocked"
        finally:
            self._cleanup_archive()

    def _cleanup_archive(self):
        archive = self.state_dir / ARCHIVE
        if not archive.is_symlink():
            try:
                archive.unlink(missing_ok=True)
            except OSError:
                self.log("download_archive_cleanup_failed")
        if not self.state.get("pending"):
            try:
                self._retain_backups()
            except OSError:
                self.log("backup_retention_cleanup_failed")

    def _retain_backups(self):
        entries = sorted((path for path in self.backups.iterdir() if path.is_dir() and not path.is_symlink()
                          and re.fullmatch(r"[0-9]+-[0-9a-f]{12}-[0-9a-f]{8}", path.name)), key=lambda path: path.name, reverse=True)
        for path in entries[3:]:
            shutil.rmtree(path)

    def run_once(self):
        lock_path = self.state_dir / ".lock"
        descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return "skipped"
            self.state = self._read_state()
            if self.state.get("blocked"):
                self.log("BLOCKED_requires_operator")
                return "blocked"
            if self.state.get("pending"):
                return self.recover()
            if self.state.get("backoff_until", 0) > time.time():
                return "backoff"
            manifest = None
            archive = self.state_dir / ARCHIVE
            try:
                manifest = validate_manifest(self.fetch_manifest())
                revision = manifest["revision"]
                if revision in (self.state.get("applied_sha"), self.state.get("failed_sha")):
                    return "skipped"
                asset = self.verify_release(manifest)
                stack, compose = self.get_stack()
                _, new_env = prepare_update(stack, compose, manifest)
                before = self.inspect_containers()
                require(SERVICES - {"migrate"} <= set(before) <= SERVICES, "unexpected_containers")
                require(all(before[name].get("State", {}).get("Running") is True for name in SERVICES - {"migrate"}), "baseline_not_running")
                previous_image = before["web"].get("Image")
                require(isinstance(previous_image, str) and DIGEST.fullmatch(previous_image)
                        and all(before[name].get("Image") == previous_image for name in APP_SERVICES & set(before)), "inconsistent_previous_image")
                archive = self.download_image(manifest, asset)
                self.load_image(archive, manifest)
                backup_dir = self.backups / (str(time.time_ns()) + "-" + revision[:12] + "-" + uuid.uuid4().hex[:8])
                backup_dir.mkdir(mode=0o700)
                snapshot = {"manifest": manifest, "stack": stack, "compose": compose, "config": self.config,
                            "containers": before, "previous_image": previous_image, "new_env": new_env}
                private_write(backup_dir / "snapshot.json", snapshot)
                self.backup_database(before, backup_dir)
                self.verify_main(manifest)
                current_stack, current_compose = self.get_stack()
                require(current_stack == stack and current_compose == compose, "stack_changed_before_update")
                current_containers = self.inspect_containers()
                require(set(current_containers) == set(before) and all(current_containers[name].get("Id") == before[name].get("Id")
                            and mounts(current_containers[name]) == mounts(before[name]) for name in before), "containers_changed_before_update")
                self.state["pending"] = {"revision": revision, "snapshot": str((backup_dir / "snapshot.json").relative_to(self.state_dir))}
                self.save_state()
                self.put_stack(compose, new_env)
                self.wait_healthy(manifest, before)
                applied_stack, applied_compose = self.get_stack()
                prepare_update(applied_stack, applied_compose, manifest)
                require(applied_compose == compose and applied_stack.get("Env") == new_env, "stack_changed_after_update")
                self.state.update({"applied_sha": revision, "failed_sha": None, "pending": None,
                                   "blocked": False, "backoff_until": 0, "image_id": manifest["image_id"],
                                   "previous_image_id": previous_image, "applied_at": int(time.time()), "last_error_code": None})
                self.save_state()
                self.log("release_applied")
                return "applied"
            except RateLimited as error:
                if self.state.get("pending"):
                    return self.recover()
                self.state["backoff_until"] = error.retry_at
                self.state["last_error_code"] = "github_rate_limited"
                self.save_state()
                return "backoff"
            except (Retryable, OSError, http.client.HTTPException) as error:
                if self.state.get("pending"):
                    return self.recover()
                self.state["backoff_until"] = time.time() + (error.retry_seconds if isinstance(error, Retryable) else 300)
                self.state["last_error_code"] = str(error) if isinstance(error, UpdateError) else "network_io_error"
                self.save_state()
                self.log("candidate_deferred_retry_after_backoff")
                return "backoff"
            except Exception as error:
                if self.state.get("pending"):
                    return self.recover()
                if manifest is not None:
                    self.state["failed_sha"] = manifest["revision"]
                self.state["last_error_code"] = str(error) if isinstance(error, UpdateError) else "unexpected_error"
                self.save_state()
                self.log("candidate_failed_no_stack_update")
                return "failed"
            finally:
                self._cleanup_archive()

    def run(self):
        while True:
            self.run_once()
            time.sleep(self.config["poll_seconds"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/config/config.json")
    parser.add_argument("--state", default="/state")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    try:
        os.umask(0o077)
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        updater = Updater(config, args.state)
        if args.once:
            return 0 if updater.run_once() in ("applied", "skipped", "rolled_back", "backoff") else 1
        updater.run()
    except KeyboardInterrupt:
        return 0
    except Exception:
        Updater.log("updater_stopped_requires_operator")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
