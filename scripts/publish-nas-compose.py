#!/usr/bin/env python3
"""Publish a verified GHCR digest as the Portainer repository Compose."""

import argparse
import copy
import json
import os
from pathlib import Path
import re
import subprocess


REPOSITORY = "happyaspic-byte/Operix"
REGISTRY_IMAGE = "ghcr.io/happyaspic-byte/operix"


def render(template, revision, image, run_id):
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("A full lowercase commit SHA is required")
    if not isinstance(image, str) or not re.fullmatch(re.escape(REGISTRY_IMAGE) + r"@sha256:[0-9a-f]{64}", image):
        raise ValueError("A fixed digest in the Operix GHCR package is required")
    if not isinstance(run_id, str) or not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("A workflow run ID is required")
    compose = copy.deepcopy(template)
    services = compose["services"]
    changes = [(services[name], "image", "__OPERIX_IMAGE__", image)
               for name in ("migrate", "web", "worker")]
    deployment_id = revision + "-" + run_id
    changes.extend([
        (services["backup"]["environment"], "DEPLOYMENT_ID", "__DEPLOYMENT_ID__", deployment_id),
        (services["deployment-check"]["labels"], "operix.deployment", "__DEPLOYMENT_ID__", deployment_id),
    ])
    for target, key, marker, replacement in changes:
        if target.get(key) != marker:
            raise ValueError("Unexpected deployment template field: " + key)
        target[key] = replacement
    metadata = {"schema": 1, "repository": REPOSITORY, "revision": revision,
                "image": image, "run_id": run_id}
    return {name: json.dumps(value, indent=2, sort_keys=True) + "\n"
            for name, value in (("compose.yaml", compose), ("deployment.json", metadata))}


def github_api(endpoint, method="GET", payload=None, missing_ok=False):
    command = ["gh", "api", "--method", method, "-H", "Accept: application/vnd.github+json",
               "repos/" + REPOSITORY + "/" + endpoint]
    if payload is not None:
        command.extend(["--input", "-"])
    result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                            text=True, capture_output=True, timeout=60)
    if result.returncode:
        if missing_ok and "(HTTP 404)" in result.stderr:
            return None
        raise RuntimeError("GitHub API request failed: " + method + " " + endpoint)
    return json.loads(result.stdout)


def publish(api, files, revision):
    if api("git/ref/heads/main")["object"]["sha"] != revision:
        return "stale"
    reference = api("git/ref/heads/nas-deploy", missing_ok=True)
    parent = reference["object"]["sha"] if reference else revision
    # Omitting base_tree deliberately excludes old source and updater files.
    tree = api("git/trees", "POST", {"tree": [
        {"path": path, "mode": "100644", "type": "blob", "content": content}
        for path, content in sorted(files.items())
    ]})["sha"]
    if reference and api("git/commits/" + parent)["tree"]["sha"] == tree:
        return "unchanged"
    commit = api("git/commits", "POST", {
        "message": "deploy: verified Operix " + revision,
        "tree": tree, "parents": [parent],
    })["sha"]
    if api("git/ref/heads/main")["object"]["sha"] != revision:
        return "stale"
    if reference:
        # The observed parent and non-force update reject a concurrent advance.
        api("git/refs/heads/nas-deploy", "PATCH", {"sha": commit, "force": False})
    else:
        api("git/refs", "POST", {"ref": "refs/heads/nas-deploy", "sha": commit})
    return "published"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
            or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or os.environ.get("GITHUB_EVENT_NAME") not in ("push", "workflow_dispatch")
            or os.environ.get("GITHUB_SHA") != args.revision
            or os.environ.get("GITHUB_RUN_ID") != args.run_id):
        parser.error("Publishing requires the trusted repository's main workflow")
    files = render(json.loads(args.template.read_text()), args.revision, args.image, args.run_id)
    print("NAS Compose publication: " + publish(github_api, files, args.revision))


if __name__ == "__main__":
    main()
