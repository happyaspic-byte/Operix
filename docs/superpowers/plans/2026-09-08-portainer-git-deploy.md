# Portainer Repository Deployment Implementation Plan

> **For agentic workers:** Use the reviewed, user-approved native Repository architecture. Complete implementation, migration, and observed Git polling verification in this session.

**Goal:** Replace the custom NAS updater with Portainer's built-in Git polling and registry image pulls.

**Architecture:** Existing main CI tests an application image, then publishes that exact image to GHCR. After anonymous pull is available, CI commits a Compose file with the immutable image digest to nas-deploy. Portainer polls this branch every minute. Compose dependencies require a database backup and successful migration before application startup, and a final dependency check waits for web health. Recovery uses a new Git revert commit; native polling does not supply automatic image rollback.

**Tech Stack:** Existing GitHub Actions, GHCR, Portainer CE 2.39.4 Git stacks, Docker Compose and PostgreSQL 17 tools.

**Approved scope:** The user explicitly selected this architecture after its tradeoffs were explained. Preserve the existing business data, named volumes, network topology, environment secrets, and HTTPS configuration. A one-time stack recreation is required by the supported Portainer API.

- [x] Replace Release publication and NAS control scripts with a small digest-to-Compose publisher. Gate publication on both current verification jobs and main. Test stale revisions, wrong registry digests, and non-forced branch updates.
- [x] Prepare deploy/nas/compose.template.json from the actual operational stack, with all persistent volumes and existing networks external, infrastructure images pinned to the current digests, and application image placeholders replaced by CI only.
- [x] Add an idempotent PostgreSQL pre-migration backup service and a dependency-only health check service. Verify backup failure, successful custom-format backup, and retained original backup on retry.
- [x] Document one-time GHCR public visibility, stack migration, native polling, manual revert recovery, and backup retention. Remove obsolete custom updater code and tests.
- [x] Run contract tests, actionlint, and Compose configuration verification; push reviewed changes and obtain successful CI plus an anonymously pullable image.
- [x] Preserve a fresh private database/configuration backup and the application network topology. After stack removal, recreate the network with the same name, driver, IPAM and options if necessary, without old Compose ownership labels. Verify its gateway before creating the Git stack with polling initially off, then verify runtime/data/HTTPS.
- [x] Enable one-minute Git polling and observe a new deployment-branch commit applied by Portainer. Retire the old updater container/API key while retaining its historical backup volume.

**Evidence:** CI run 34246817256 passed; native stack 24 applied deployment commit 232db294915dc4a4493aa491fd6206e78a3cf88b by polling. Runtime verification confirmed unchanged persistent mounts, application environment, all 34 table counts, HTTPS configuration and successful backup/migration/health checks. The old updater container, configuration volume and dedicated API key were retired; its historical backup volume was retained.
