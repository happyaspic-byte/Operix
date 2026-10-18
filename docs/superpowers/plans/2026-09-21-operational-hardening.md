# Operix operational hardening implementation plan

> Execute with `superpowers:executing-plans`: test each change against the existing behavior, then obtain one independent whole-branch review.

**Goal:** Correct the September 21 review findings, verify the complete application and recovery pipeline, and release only with explicit evidence of deployment readiness.

**Architecture:** Retain the current Next.js/PostgreSQL application and transactional integrity. Reuse a shared write guard and asset picker; keep bounded serialization until measured evidence warrants changing the locking model.

**Scope and authorization:** The user approved all previously reported improvements, testing, and deployment. Additional business features are proposals, not unrequested production additions. Production data must never be used as disposable test data.

## Global constraints

- Node.js 24 (`>=24.0.0 <25`), PostgreSQL 17; no framework upgrade in this change.
- Preserve existing customer, inspection, contract, ticket, and archived-record behavior except the reviewed defects.
- Tests use isolated databases, synthetic records and private temporary storage.
- No production erasure, restore, failure injection, or unverified rollback.
- Preserve atomic imports and cross-customer relationship integrity.
- No credentials or customer data in Git, logs, CI artifacts or this plan.
- Record separate evidence for CI success, image publication, NAS adoption, and live service health.

## Review focus

- A record erased between a read and a write must not accept new content.
- Asset selections survive searching, delayed responses, editing and archived existing links; customer changes clear incompatible selections.
- Sites with archived contacts still cannot acquire a different customer.
- Busy writes time out without partial commit; unrelated reads remain available.
- Failed remote backup replication must not be reported as successful off-host protection.

### Task 1: Data integrity

Files: `src/lib/records.ts`, `src/lib/reports.ts`, `src/app/api/entries/route.ts`, `src/lib/documents.ts`, `tests/operational-integrity.test.ts`, relevant E2E tests.

- [ ] Add isolated-DB regressions for reports on erased completed inspections and resolved tickets; assert `AppError.status === 410` and unchanged report counts.
- [ ] Add regressions for moving an empty site with active or archived contacts between customers; assert 409 and unchanged customer IDs. Empty sites with no contacts remain movable.
- [ ] Run tests against the baseline and retain expected failures.
- [ ] Implement a common record write guard and apply it under the business lock to entries, reports and other affected mutation paths. Extend site-child validation to contacts.
- [ ] Verify new tests and full domain suite; commit.

### Task 2: Searchable asset selection

Files: `src/components/record-editor.tsx`, shared asset picker component if extracted, `e2e/contract-ticket-assets.spec.ts`.

- [ ] Create synthetic datasets exceeding 100 assets, then select a target beyond the first page in a contract and a ticket. Verify persisted associations through the API.
- [ ] Exercise customer switching, retained selections while searching, edit hydration, and delayed lookup responses.
- [ ] Run against baseline: target must be unavailable or missing its search control.
- [ ] Reuse the inspection picker with an explicit customer scope, customer-required behavior and retained existing selections; keep existing inspection labels and keyboard behavior.
- [ ] Run the affected E2E suites, typecheck, lint and full domain suite; commit.

### Task 3: Bounded contention and supported runtime

Files: `src/lib/transactions.ts`, `src/lib/http.ts`, runtime guard, Dockerfile, dependency policy, PostgreSQL contention test, runtime tests.

- [ ] Add a real PostgreSQL test holding the business lock; a second write must fail safely within a fixed timeout with no inserted row, while reads work. Skip only this concurrency probe on PGlite.
- [ ] Add tests rejecting unsupported Node majors and accepting Node 24.
- [ ] Set a transaction-local five-second business-lock timeout; return a retryable service-busy response for lock exhaustion while preserving other errors.
- [ ] Enforce Node 24 at installation and startup, align Node type definitions, and prevent unplanned Docker major bumps.
- [ ] Measure a synthetic 1,000-row atomic import and concurrent access in PostgreSQL; record actual duration, not a guessed capacity claim.
- [ ] Run the full applicable suite and commit.

### Task 4: Recovery and release evidence

Files: backup/recovery scripts, operation health logic, NAS deployment tooling, CI, tests, deployment documentation and README.

- [ ] Add executable script tests for overlapping backups, transfer failure and successful replication; assert no false remote-success state and no premature writer restart.
- [ ] Track encrypted backup and confirmed remote-copy freshness separately; do not enable a production requirement before its backing job exists and succeeds.
- [ ] Include the source revision in the built runtime health response and add a read-only HTTPS deployment verifier for health, expected revision and login availability.
- [ ] Add CI evidence generation for revision, domain/E2E counts and recovery results. README links to current evidence and labels historical counts.
- [ ] Prepare least-privilege branch protection configuration and confirm required checks before merge. Apply via supported authenticated settings only.
- [ ] Keep the existing NAS DB pre-migration backup and document that it is distinct from an encrypted full backup and remote replication.

### Task 5: Review, release, and feature proposals

- [ ] Run typecheck, lint, domain tests, browser/API tests, production dependency audit and build.
- [ ] Obtain independent whole-branch review; fix material findings with regression tests.
- [ ] Create a PR; require fresh PostgreSQL and container backup/restore CI for its exact head.
- [ ] Confirm branch protection, live URL/access and recovery evidence before release; merge only when release gates are verifiable.
- [ ] Follow main CI through image publication; compare deployment revision and probe the actual HTTPS service. Never infer NAS health from a Git commit.
- [ ] Document feature candidates: maintenance visit preparation, evidence-backed customer report composition, and cross-site asset change history. Distinguish existing features from new proposed capabilities.
- [ ] Report completed changes, test evidence, deployment status, and concrete access blockers separately.
