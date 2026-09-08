#!/usr/bin/env python3
"""Create and verify the manifest for a CI-tested Operix Docker image."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


REPOSITORY = "happyaspic-byte/Operix"
ARCHIVE = "operix-image.tar.gz"
MAX_ARCHIVE_BYTES = 2_000_000_000
FIELDS = {"schema", "repository", "revision", "image", "image_id", "archive",
          "sha256", "size", "run_id"}


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def validate_metadata(data, revision):
    if not matches(r"[0-9a-f]{40}", revision):
        raise ValueError("A full lowercase commit SHA is required")
    if not isinstance(data, dict) or set(data) != FIELDS:
        raise ValueError("Unexpected manifest fields")
    if type(data["schema"]) is not int or data["schema"] != 1:
        raise ValueError("Unsupported manifest schema")
    if data["repository"] != REPOSITORY or data["revision"] != revision:
        raise ValueError("Manifest repository or revision mismatch")
    if data["image"] != "operix:github-" + revision or data["archive"] != ARCHIVE:
        raise ValueError("Unexpected image tag or archive name")
    if not matches(r"sha256:[0-9a-f]{64}", data["image_id"]):
        raise ValueError("Invalid Docker image ID")
    if not matches(r"[0-9a-f]{64}", data["sha256"]):
        raise ValueError("Invalid archive checksum")
    if type(data["size"]) is not int or not 0 < data["size"] <= MAX_ARCHIVE_BYTES:
        raise ValueError("Archive must contain between 1 and 2,000,000,000 bytes")
    if not matches(r"[1-9][0-9]*", data["run_id"]):
        raise ValueError("Invalid workflow run ID")


def archive_digest(path):
    path = Path(path)
    info = path.lstat()
    if path.name != ARCHIVE or not stat.S_ISREG(info.st_mode):
        raise ValueError("Archive must be a regular file with the expected name")
    if not 0 < info.st_size <= MAX_ARCHIVE_BYTES:
        raise ValueError("Archive size exceeds the supported range")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            size += len(chunk)
            if size > MAX_ARCHIVE_BYTES:
                raise ValueError("Archive grew beyond the size limit")
            digest.update(chunk)
    if size != info.st_size:
        raise ValueError("Archive changed while being hashed")
    return digest.hexdigest(), size


def create_manifest(archive, revision, image_id, run_id):
    checksum, size = archive_digest(archive)
    data = {"schema": 1, "repository": REPOSITORY, "revision": revision,
            "image": "operix:github-" + revision, "image_id": image_id,
            "archive": ARCHIVE, "sha256": checksum, "size": size,
            "run_id": run_id}
    validate_metadata(data, revision)
    return data


def unique_fields(pairs):
    data = {}
    for key, value in pairs:
        if key in data:
            raise ValueError("Duplicate manifest field")
        data[key] = value
    return data


def verify_manifest(manifest, archive, revision):
    path = Path(manifest)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16384:
        raise ValueError("Manifest must be a regular file of at most 16 KiB")
    data = json.loads(path.read_bytes(), object_pairs_hook=unique_fields)
    validate_metadata(data, revision)
    checksum, size = archive_digest(archive)
    if data["sha256"] != checksum or data["size"] != size:
        raise ValueError("Archive content does not match its manifest")
    return data


class GitHub:
    """Use the job-scoped GH_TOKEN without placing credentials in arguments."""

    def api(self, endpoint, method="GET", payload=None, missing_ok=False):
        command = ["gh", "api", "--method", method,
                   "-H", "Accept: application/vnd.github+json",
                   "-H", "X-GitHub-Api-Version: 2022-11-28",
                   "repos/" + REPOSITORY + "/" + endpoint]
        if payload is not None:
            command.extend(["--input", "-"])
        result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                                capture_output=True, text=True, timeout=60)
        if result.returncode:
            if missing_ok and "(HTTP 404)" in result.stderr:
                return None
            raise RuntimeError("GitHub API request failed: " + method + " " + endpoint)
        return json.loads(result.stdout)

    def upload(self, tag, manifest, archive):
        subprocess.run(["gh", "release", "upload", tag, str(manifest), str(archive),
                        "--clobber", "--repo", REPOSITORY], check=True, timeout=600)

    def download(self, tag, directory):
        subprocess.run(["gh", "release", "download", tag, "--repo", REPOSITORY,
                        "--pattern", "manifest.json", "--pattern", ARCHIVE,
                        "--dir", str(directory)], check=True, timeout=600)


def validate_release(release, revision):
    if (release.get("tag_name") != "deploy-" + revision
            or release.get("target_commitish") != revision
            or release.get("draft") is not False
            or release.get("prerelease") is not True
            or release.get("immutable") is not True):
        raise ValueError("Expected a published immutable prerelease for this exact commit")
    assets = release.get("assets", [])
    if len(assets) != 2 or {asset["name"] for asset in assets} != {ARCHIVE, "manifest.json"}:
        raise ValueError("Release must contain exactly the image archive and manifest")
    for asset in assets:
        limit = MAX_ARCHIVE_BYTES if asset["name"] == ARCHIVE else 16384
        if type(asset.get("size")) is not int or not 0 < asset["size"] <= limit:
            raise ValueError("Release asset size exceeds the supported range")
        if asset.get("state", "uploaded") != "uploaded":
            raise ValueError("Release asset upload is incomplete")


def publish(github, manifest, archive, revision, run_id):
    incoming = verify_manifest(manifest, archive, revision)
    if incoming["run_id"] != run_id:
        raise ValueError("The new deployment artifact must come from this workflow run")

    def is_current_main():
        return github.api("git/ref/heads/main")["object"]["sha"] == revision

    if not is_current_main():
        return False
    tag = "deploy-" + revision
    release = github.api("releases/tags/" + tag, missing_ok=True)
    # The by-tag endpoint documents published releases only. Drafts left by an
    # interrupted upload are visible in the authenticated release listing.
    page = 1
    while release is None:
        listed = github.api("releases?per_page=100&page=" + str(page))
        release = next((item for item in listed if item.get("tag_name") == tag), None)
        if len(listed) < 100:
            break
        page += 1
    if release is None:
        release = github.api("releases", "POST", {
            "tag_name": tag, "target_commitish": revision,
            "name": "NAS deployment " + revision,
            "body": "Image exported after application and container verification for " + revision + ".",
            "draft": True, "prerelease": True, "make_latest": "false",
        })
    if release.get("draft") is True:
        if release.get("target_commitish") != revision or release.get("tag_name") != tag:
            raise ValueError("Existing draft does not target the requested commit")
        # Only an unpublished draft may recover an interrupted upload.
        github.upload(tag, manifest, archive)
        github.api("releases/" + str(release["id"]), "PATCH", {
            "draft": False, "prerelease": True, "make_latest": "false",
        })
        release = github.api("releases/tags/" + tag)
    validate_release(release, revision)
    tag_object = github.api("git/ref/tags/" + tag)["object"]
    if tag_object.get("type") != "commit" or tag_object.get("sha") != revision:
        raise ValueError("Release tag does not reference the verified commit")

    with tempfile.TemporaryDirectory(prefix="operix-release-") as directory:
        github.download(tag, directory)
        published_manifest = Path(directory, "manifest.json")
        published = verify_manifest(published_manifest, Path(directory, ARCHIVE), revision)
        run = github.api("actions/runs/" + published["run_id"])
        if (run.get("path") != ".github/workflows/ci.yml"
                or run.get("event") not in ("push", "workflow_dispatch")
                or run.get("head_branch") != "main" or run.get("head_sha") != revision
                or run.get("repository", {}).get("full_name") != REPOSITORY):
            raise ValueError("Published manifest is not bound to the trusted main workflow")
        if published["run_id"] != run_id and (
                run.get("status") != "completed" or run.get("conclusion") != "success"):
            raise ValueError("Existing release requires a successful original workflow run; rerun that run")
        content = published_manifest.read_bytes()

    if not is_current_main():
        return False
    if github.api("git/ref/heads/nas-deploy", missing_ok=True) is None:
        github.api("git/refs", "POST", {"ref": "refs/heads/nas-deploy", "sha": revision})
    existing = github.api("contents/manifest.json?ref=nas-deploy", missing_ok=True)
    if existing is not None:
        previous = base64.b64decode("".join(existing["content"].split()), validate=True)
        if previous == content:
            return True
    payload = {
        "message": "deploy: publish verified NAS manifest for " + revision,
        "content": base64.b64encode(content).decode("ascii"), "branch": "nas-deploy",
    }
    if existing is not None:
        payload["sha"] = existing["sha"]
    # The file SHA protects a concurrent pointer edit; never reset the branch.
    if not is_current_main():
        return False
    github.api("contents/manifest.json", "PUT", payload)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("archive", type=Path)
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--revision", required=True)
    create.add_argument("--image-id", required=True)
    create.add_argument("--run-id", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("manifest", type=Path)
    verify.add_argument("archive", type=Path)
    verify.add_argument("--revision", required=True)
    publishing = commands.add_parser("publish")
    publishing.add_argument("manifest", type=Path)
    publishing.add_argument("archive", type=Path)
    publishing.add_argument("--revision", required=True)
    arguments = parser.parse_args()
    if arguments.command == "create":
        data = create_manifest(arguments.archive, arguments.revision,
                               arguments.image_id, arguments.run_id)
        arguments.output.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    elif arguments.command == "verify":
        verify_manifest(arguments.manifest, arguments.archive, arguments.revision)
    else:
        if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
                or os.environ.get("GITHUB_REF") != "refs/heads/main"
                or os.environ.get("GITHUB_EVENT_NAME") not in ("push", "workflow_dispatch")
                or os.environ.get("GITHUB_SHA") != arguments.revision
                or not matches(r"[1-9][0-9]*", os.environ.get("GITHUB_RUN_ID"))):
            parser.error("Publishing is restricted to the trusted repository's main workflow")
        advanced = publish(GitHub(), arguments.manifest, arguments.archive,
                           arguments.revision, os.environ["GITHUB_RUN_ID"])
        print("Verified NAS manifest published." if advanced else "main advanced; deployment pointer unchanged.")


if __name__ == "__main__":
    main()
