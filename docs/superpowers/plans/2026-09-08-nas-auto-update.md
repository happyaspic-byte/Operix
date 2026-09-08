> Historical design: superseded by [Portainer Repository deployment](../../../deploy/nas/README.md).

# NAS Automatic Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically deploy successful GitHub main revisions to the existing NAS stack.

**Architecture:** Publish a tested Docker image and checksum manifest as an immutable release. A public branch carries the deployment pointer; a NAS Python sidecar polls it and updates the existing Portainer stack after validating the workflow, image, and production configuration.

**Tech Stack:** GitHub Actions and Releases, Docker Engine API, Portainer CE 2.39.4 API, Python standard library.

**Spec:** `docs/superpowers/specs/2026-09-08-nas-auto-update.md`

## Global Constraints

- Preserve Portainer stack 19 and endpoint 3, all current Env values except OPERIX_IMAGE, and the current Compose file.
- Deploy only happyaspic-byte/Operix main revisions whose fixed CI workflow succeeded.
- Never publish operational credentials or data. Keep local private artifacts mode 0600.
- Preserve existing worktrees and unrelated containers.
- Poll every 60 seconds; use GitHub REST only for a changed deployment candidate.

### Task 1: Publish the verified image

**Files:** `.github/workflows/ci.yml`, `scripts/create-deploy-manifest.py`, `tests/test_nas_manifest.py`.

**Interfaces:** Produce schema-1 manifest with repository, revision, image, image_id, archive, sha256, size, run_id. Archive name is `operix-image.tar.gz`; image is `operix:github-<full SHA>`.

- [x] Add contract tests: invalid SHA or image ID and missing/oversized archive cannot produce a manifest. Run `python3 -m unittest discover -s tests -p 'test_nas_*.py'`.
- [x] Export the tested container image after container tests. Gate publishing on both verification jobs, main, and the original repository.
- [x] Create draft release `deploy-<full SHA>`, upload archive and manifest, then publish. Recheck main before updating `nas-deploy/manifest.json`.
- [x] Validate workflow syntax, manifest tests, and immutable release rerun behavior.

### Task 2: Validate and apply one release

**Files:** `deploy/nas-auto-update/updater.py`, `tests/test_nas_updater.py`.

**Interfaces:** Consume only the schema above; use NAS-local config for the repository, fixed workflow, endpoint, stack, and Portainer credentials. Persistent state records success, failed SHA, and interrupted deployment.

- [x] Write tests rejecting mismatched workflow/revision, arbitrary archive/image names, image load errors, environment loss, and repeated failed candidates.
- [x] Implement bounded download and checksum verification, validate release tag/workflow/main, and inspect loaded image ID and architecture.
- [x] Snapshot the live Compose and full Env privately; create a PostgreSQL custom-format backup before replacement.
- [x] PUT the same stack with only OPERIX_IMAGE changed and RepullImageAndRedeploy false. Verify web, worker, database, scanner, and HTTPS readiness; restore the previous image if replacement fails.
- [x] Verify idempotent polling, crash recovery, rate-limit backoff, and no credential leakage in exceptions.

### Task 3: Install and verify automatic operation

**Files:** `deploy/nas-auto-update/README.md`; private installation/evidence outside the repository.

- [x] Review the publisher and updater together; run Python tests and Compose/static validation.
- [ ] Publish the main commit and wait for CI success and an immutable release with matching assets.
- [ ] Install the updater as a bounded, restartable NAS container with private persistent state; preserve a rollback configuration and initial database backup.
- [ ] Observe automatic image replacement, actual running image ID/revision, HTTP health, and unchanged persistent volume identities.
- [ ] Record deployment revision, workflow URL, polling behavior, update/rollback operations, and limitations in documentation and final evidence.
