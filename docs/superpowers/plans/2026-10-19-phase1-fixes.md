# Operix Phase 1 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the verified Phase 1 defects from the 2026-10-19 review on top of the merged operational-hardening branch.

**Architecture:** Small, independent fixes in the existing Next.js 16 + raw-SQL codebase. Each task adds node:test coverage (PGlite); UI-facing tasks add a Playwright spec. No new dependencies.

**Tech Stack:** Next.js 16.3 App Router, React 19.2, TypeScript 7, zod 4, pg 8 / PGlite 0.5, node:test via tsx, Playwright 1.62.

**Spec:** No separate spec file. The binding requirements are the Background bullets below, taken from the 2026-10-19 review (each was reproduced or confirmed in code).

## Background (binding requirements)

- PostgreSQL containers default to UTC, the app uses KST: `CURRENT_DATE` and `timestamptz::date` filters (contract expiry, created_at ranges, document/report lists, security-log review) and report document numbers are a day off between 00:00 and 09:00 KST.
- Migrations inherit the app pool's `statement_timeout` 30s / `query_timeout` 35s, so a slow future migration fails every deploy; there is no lock against concurrent runs.
- `scripts/seed.ts` runs on every internal-server deploy. If the bootstrap admin's email is changed, its fixed id collides (only `ON CONFLICT(email)` is handled) and migrate exits 1; `ADMIN_PASSWORD` must stay in `.env` forever.
- "모두 읽음" in the notification panel always gets HTTP 400: Next 16 passes a non-null empty body for a body-less PATCH, so the route calls `readJson("")`. The click handler has no error handling.
- Unexpected 500s and worker failures log no error name, message or stack; one failing maintenance job also skips the remaining ones.
- `(erp)/error.tsx` uses `reset`, which in this Next version does not re-fetch, so "다시 시도" cannot recover from server errors. `/constructor`-style URLs pass the `!catalog[kind]` guard and show the error page instead of the not-found page (the app keeps HTTP 200 because `(erp)/loading.tsx` streams every page, so Task 6 Step 4 asserts the page, not the status). `tests/user-organization-privacy.test.ts` fails when `SESSION_SECRET` is unset.
- Contract detail shows the customer name as "이전 계약"; component and VM detail show the raw asset UUID as "대상 자산".

## Global Constraints

- Node.js 24 is required. Before running any command, use a shell with Node 24 (24.22.0 was used) first on PATH, a synthetic `SESSION_SECRET`, and `DATABASE_URL`/`TEST_DATABASE_URL` unset. Never point any command at a real database.
- Focused tests: `node --import tsx --test tests/<file>.test.ts`. Full suite: `npm test`. Tests use in-memory PGlite through `tests/helpers/isolated-db.ts`.
- Before every commit: `npm run typecheck`, `npm run lint` and `npm run format:check` must pass, and `npm test` must pass.
- E2E only where a task says so: use a local e2e runner that migrates and seeds a fresh embedded (PGlite) database, builds (unless told not to), then runs Playwright on the given spec files against port 3000 as admin `admin@operix.test` with the `ADMIN_PASSWORD` from its environment. Never run two copies at once.
- Business time zone is `Asia/Seoul`; business dates are `YYYY-MM-DD` strings; "today" is `todayKST()` from `src/lib/dates.ts`.
- User-facing copy is Korean in the existing polite tone (e.g. "다시 시도해 주세요.").
- Never log personal data: no request bodies, SQL parameters, or pg error `detail`/`hint`/`where`.
- Match surrounding code style (Prettier, sparse comments, existing naming). No new npm dependencies.
- Work on branch `improve/phase1-fixes` only. New commits only: never amend, rebase, push, or touch `main`. Commit subjects use `fix:`/`test:` prefixes and every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A PostgreSQL URL that already carries `options` (the tests' `-c search_path=…`) must keep it when the time-zone option is added — Task 1 test. (Task 8 replaced the URL rewrite `withSessionTimeZone` with `applySessionTimeZone`, run through pg-pool's `onConnect` hook and a post-connect `SET` on the migration client; the URL now passes through unchanged, so its options are kept by construction and the tests assert that.)
2. Migrations must still apply exactly once and remain idempotent on re-run, on both PGlite and PostgreSQL code paths — Task 2 test.
3. Seed re-run after the bootstrap admin's email changed, and re-run without `ADMIN_*` — Task 3 test.
4. PATCH `/api/notifications` with an empty body, `{ "all": true }`, `{ "ids": [...] }`, and malformed JSON (must stay 400) — Task 4 tests.
5. Error logs must never contain pg `detail` values or request data — Task 5 test.

---

### Task 1: KST database session and report numbers

**Files:**
- Modify: `src/lib/db.ts` (`connect()`: pg Pool connection string; PGlite init)
- Modify: `src/lib/reports.ts` (the `documentNumber` built from `new Date().toISOString()`)
- Create: `tests/timezone.test.ts`

**Interfaces:**
- Produces: `export const DB_TIME_ZONE = "Asia/Seoul"` and `export function withSessionTimeZone(connectionString: string): string` in `src/lib/db.ts` (Task 2 uses it). *Superseded: Task 8 replaced `withSessionTimeZone` with `applySessionTimeZone`, run through pg-pool's `onConnect` hook and a post-connect `SET` on the migration client.*
- Produces: `export function reportDocumentNumber(id: string, today = todayKST()): string` in `src/lib/reports.ts`.

- [ ] **Step 1: Write the failing tests** in `tests/timezone.test.ts`:
  - `new URL(withSessionTimeZone("postgresql://u:p@db:5432/operix")).searchParams.get("options") === "-c TimeZone=Asia/Seoul"`.
  - For `postgresql://u:p@db:5432/operix?options=-c%20search_path%3Dtest_schema&sslmode=disable`: options `=== "-c search_path=test_schema -c TimeZone=Asia/Seoul"` and `sslmode === "disable"`.
  - Applying `withSessionTimeZone` twice yields the same string as applying it once.
  - With `isolatedDatabase()`: `SELECT current_setting('TimeZone')` is `"Asia/Seoul"`; `SELECT (TIMESTAMPTZ '2026-10-18 15:30:00+00')::date::text` is `"2026-10-19"`; `SELECT CURRENT_DATE::text` equals `todayKST()`.
  - With `isolatedDatabase()`, an admin user row and records created through `saveRecord` (follow `tests/domain.test.ts`): a `dated` maintenance contract with `end_date = addDays(todayKST(), -1)` is returned by `listRecords("contracts", admin, new URLSearchParams("expiry=overdue"))` and not by `expiry=30`.
  - `reportDocumentNumber("abcdef12-3456-4789-8abc-def012345678", "2026-10-19") === "OPX-20261019-ABCDEF12"`.

- [ ] **Step 2: Run to verify failure:** `TZ=UTC node --import tsx --test tests/timezone.test.ts` — expected FAIL (missing exports, `TimeZone` is not `Asia/Seoul`, UTC date `2026-10-18`).

- [ ] **Step 3: Implement.** `withSessionTimeZone` parses with `new URL`, appends `-c TimeZone=Asia/Seoul` (from `DB_TIME_ZONE`) to any existing `options` value separated by one space, and returns the URL unchanged if that exact option is already present. The pg Pool uses `connectionString: withSessionTimeZone(process.env.DATABASE_URL)`. PGlite runs `SET TIME ZONE 'Asia/Seoul'` right after `await pg.waitReady`. `reports.ts` builds the number with `reportDocumentNumber(id)`.

- [ ] **Step 4: Verify:** the focused test passes both with `TZ=UTC` and with the default TZ; then the Global Constraints checks.

- [ ] **Step 5: Commit** `fix: use Asia/Seoul for database dates and report numbers`.

### Task 2: Dedicated migration connection

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `scripts/migrate.ts`
- Create: `tests/migration-connection.test.ts`

**Interfaces:**
- Consumes: `withSessionTimeZone` (Task 1). *Superseded: Task 8 replaced it with `applySessionTimeZone`, run through pg-pool's `onConnect` hook and a post-connect `SET` on the migration client.*
- Produces in `src/lib/db.ts`:
  - `export const MIGRATION_LOCK_KEY = 7305010`
  - `export function migrationClientConfig(connectionString: string): ClientConfig` (pg) returning exactly `{ connectionString: withSessionTimeZone(connectionString), connectionTimeoutMillis: 10000, statement_timeout: 0, lock_timeout: 60000, application_name: "operix-migrate" }` and no `query_timeout`. *Superseded by Task 8: `connectionString` is passed through unchanged and `statement_timeout: 0` is set by a post-connect `SET`.*
  - `export async function connectForMigrations(): Promise<Database>`: with `DATABASE_URL`, a single connected `pg.Client` built from `migrationClientConfig`, wrapped in the existing `Database` interface (`transaction` = BEGIN/COMMIT/ROLLBACK on that client, `close` = `client.end()`, rows normalized like the pool path); otherwise `getDb()`.

- [ ] **Step 1: Write the failing tests:**
  - `migrationClientConfig("postgresql://u:p@db:5432/operix")` deep-equals the object above (TimeZone option present) and `"query_timeout" in config === false`.
  - Integration: with a fresh temp directory as `PGLITE_PATH` (`OPERIX_EMBEDDED=1`, `DATABASE_URL=""`), run `node --import tsx scripts/migrate.ts` twice with `execFile` (cwd = repo root). Both exit 0; the first output lists `Applied 001_initial.sql` … `Applied 007_backup_replication.sql`; the second prints no `Applied` line.

- [ ] **Step 2: Run to verify failure:** `node --import tsx --test tests/migration-connection.test.ts` — expected FAIL (missing exports).

- [ ] **Step 3: Implement** `migrationClientConfig`, `connectForMigrations` and `MIGRATION_LOCK_KEY`. `scripts/migrate.ts` uses `connectForMigrations()`, takes `pg_advisory_lock(MIGRATION_LOCK_KEY)` before reading `schema_migrations`, releases it with `pg_advisory_unlock` in `finally`, then closes. The checksum logic and console output stay the same.

- [ ] **Step 4: Verify** the focused test and the Global Constraints checks.

- [ ] **Step 5: Commit** `fix: run migrations on a dedicated connection without request timeouts`.

### Task 3: Idempotent admin bootstrap seed

**Files:**
- Modify: `scripts/seed.ts`
- Create: `tests/seed.test.ts`
- Modify: `docs/DEPLOYMENT.md` (the line describing `ADMIN_EMAIL`/`ADMIN_PASSWORD`)

**Interfaces:**
- Produces: seed behaviour only (no exports).

- [ ] **Step 1: Write the failing tests** in `tests/seed.test.ts`, running the real scripts with `execFile(process.execPath, ["--import", "tsx", "scripts/<name>.ts"], { cwd: repoRoot, env })` against one fresh temp `PGLITE_PATH` (`OPERIX_EMBEDDED=1`, `DATABASE_URL=""`, `CI=true`, `SEED_DEMO` unset, a 32+ char `SESSION_SECRET`). Run `scripts/migrate.ts` first. Open the PGlite directory in the test process only while no child is running, and close it before the next child.
  - No `ADMIN_EMAIL`/`ADMIN_PASSWORD` on an empty DB → non-zero exit; stderr mentions `ADMIN_EMAIL`.
  - With `ADMIN_EMAIL=seed-admin@operix.test` and a 12+ char `ADMIN_PASSWORD` → exit 0; exactly one active admin.
  - `UPDATE users SET email='renamed-admin@operix.test'` for that admin, then re-run with the same env → exit 0; still exactly one admin row in `users`.
  - Re-run with no `ADMIN_*` → exit 0; stdout contains `Administrator already exists; bootstrap skipped.`

- [ ] **Step 2: Run to verify failure:** `node --import tsx --test tests/seed.test.ts` — expected FAIL on the rename and no-`ADMIN_*` cases.

- [ ] **Step 3: Implement.** If a user with `role='admin' AND active AND deleted_at IS NULL AND privacy_erased_at IS NULL` exists, skip the bootstrap insert, do not require `ADMIN_*`, and print `Administrator already exists; bootstrap skipped.`. Otherwise keep today's `ADMIN_*` validation and message, insert with `ON CONFLICT DO NOTHING` (no conflict target), then re-check; if no active admin exists, throw `ADMIN_EMAIL belongs to an existing account that is not an active administrator. Choose another ADMIN_EMAIL.`. Demo seeding (`SEED_DEMO=1`) uses the earliest-created active admin wherever it used the bootstrap admin row.

- [ ] **Step 4: Update `docs/DEPLOYMENT.md`:** state that `ADMIN_EMAIL`/`ADMIN_PASSWORD` are only needed until the first administrator exists and can then be removed from `.env`.

- [ ] **Step 5: Verify** the focused test and the Global Constraints checks.

- [ ] **Step 6: Commit** `fix: make admin bootstrap seed idempotent`.

### Task 4: Mark-all-read notifications

**Files:**
- Modify: `src/lib/http.ts`
- Modify: `src/app/api/notifications/route.ts` (`PATCH`)
- Modify: `src/components/shell.tsx` (the "모두 읽음" button in the notification panel)
- Test: `tests/security-http.test.ts` (extend), `e2e/notifications.spec.ts` (create)

**Interfaces:**
- Produces: `export async function readOptionalJson(request: Request): Promise<Record<string, any> | null>` in `src/lib/http.ts` — `null` when the body has zero bytes; otherwise the same limits, errors and messages as `readJson` (share one JSON-object parser between them; do not duplicate it).
- PATCH `/api/notifications` body: `{ "all": true }` or `{ "ids": [uuid, …] }` (1–100); an empty body also means all. Anything else → 400 with the existing message.

- [ ] **Step 1: Write the failing unit tests** for `readOptionalJson`: PATCH request without body → `null`; with body `""` → `null`; body `{"all":true}` → `{ all: true }`; body `[]` → `AppError` 400; body `{` → `AppError` 400; a body of 1 MiB + 1 byte → `AppError` 413.

- [ ] **Step 2: Run to verify failure:** `node --import tsx --test tests/security-http.test.ts`.

- [ ] **Step 3: Implement** the helper and the route (`z.union` of the two strict objects).

- [ ] **Step 4: Fix the button:** send `{ method: "PATCH", body: JSON.stringify({ all: true }) }`; on failure leave the list and badge unchanged and show the error inside the panel with the existing `ErrorNotice` from `./ui`; clear the error on success and when the panel closes.

- [ ] **Step 5: Write `e2e/notifications.spec.ts`:** log in as admin the way existing specs do. If `GET /api/notifications?read=unread` shows no unread notification, arrange one through public API calls only. Open the notification panel, click "모두 읽음", expect the unread indicator to disappear and `unread_total` to become 0. Also assert that `PATCH` with `{ ids: [<an existing notification id>] }` returns 200.

- [ ] **Step 6: Verify:** unit tests, the local e2e runner on `e2e/notifications.spec.ts`, then the Global Constraints checks.

- [ ] **Step 7: Commit** `fix: make mark-all-read notifications work`.

### Task 5: Server and worker error logging

**Files:**
- Create: `src/lib/error-log.ts`
- Create: `src/lib/maintenance.ts`
- Modify: `src/lib/http.ts` (`failure()`: the unexpected-error branch only)
- Modify: `scripts/worker.ts` (`tick()`)
- Create: `tests/error-log.test.ts`

**Interfaces:**
- Produces: `export function errorSummary(error: unknown): Record<string, unknown>` in `src/lib/error-log.ts`:
  - always `name` (the error's `name`, else `typeof` / `"null"`);
  - string `code` and the pg fields `severity`, `table`, `column`, `constraint`, `routine` when present;
  - `message` (first 300 chars) only when the error has no `code` and is a `TypeError`, `RangeError` or `ReferenceError` or carries one of the fixed connectivity messages of pg and pg-pool (final review: parsers and libraries quote their input, so no other message is logged);
  - `stack`: the stack lines after the first (the first repeats the message), at most 8, trimmed, joined by `\n`, capped at 1500 chars;
  - never `detail`, `hint`, `where`, `query`, `parameters`, `internalQuery`. Must not throw for any input.
- Produces: `export async function runMaintenanceJobs(jobs: Array<[string, () => Promise<unknown>]>, log: (line: string) => void = console.error): Promise<string[]>` in `src/lib/maintenance.ts`: runs jobs in order, catches each failure, logs one JSON line `{ event: "operix.worker.job_failed", job, ...errorSummary(e) }`, continues, and returns the failed job names.

- [ ] **Step 1: Write the failing tests:**
  - `errorSummary(new TypeError("boom"))` → `name "TypeError"`, `message "boom"`, `stack` not containing `TypeError: boom`.
  - A pg-like `Error` with `code "23505"`, `detail "Key (email)=(a@b.c) already exists."`, `table "users"`, `constraint "users_email_key"`, `severity "ERROR"` → those fields present, no `message`, and `JSON.stringify(result)` does not contain `a@b.c`.
  - A 1000-char `RangeError` message → `message.length === 300`. Inputs `"x"`, `null` and `{}` return an object with `name` and do not throw.
  - `failure(new TypeError("boom"))` with `console.error` stubbed: one JSON log line with `event "operix.request.failed"`, `request_id`, `name`, `message`; response status 500. `failure(new AppError(400, "x"))` logs nothing.
  - `runMaintenanceJobs([["a", ok], ["b", throws], ["c", ok]], log)` → returns `["b"]`, `a` and `c` both ran, `log` called once with `job: "b"`.

- [ ] **Step 2: Run to verify failure:** `node --import tsx --test tests/error-log.test.ts`.

- [ ] **Step 3: Implement.** In `failure()`, the unexpected-error log becomes `{ event: "operix.request.failed", request_id, ...errorSummary(error), code: code || "internal_error" }`; the existing 55P03/23505/23503 and `AppError` branches stay unchanged. `scripts/worker.ts` runs `runJobs`, `purgeDeletedFiles` and `scanPendingDocuments` through `runMaintenanceJobs`: when none failed, keep the existing success update and log; when any failed, set `last_error` to `maintenance_failed:<names joined by ",">`, `heartbeat_at=now()`, `started_at=NULL`, leave `last_success` untouched, and set `process.exitCode = 1` with `--once`.

- [ ] **Step 4: Verify** the focused test and the Global Constraints checks.

- [ ] **Step 5: Commit** `fix: log failure causes without personal data`.

### Task 6: Small correctness fixes

**Files:**
- Modify: `src/app/(erp)/error.tsx`
- Modify: `src/app/(erp)/[kind]/page.tsx`
- Modify: `src/app/(erp)/[kind]/[id]/page.tsx`
- Modify: `tests/user-organization-privacy.test.ts`
- Test: `e2e/security-http.spec.ts` (extend)

**Interfaces:**
- Produces: none.

- [ ] **Step 1:** `error.tsx` takes `{ retry }: { retry: () => void }` and the button calls `retry()` (see `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`). Copy stays as is.

- [ ] **Step 2:** Both page guards become `if (!Object.hasOwn(catalog, kind)) notFound();` (use each file's existing variable).

- [ ] **Step 3:** At the top of `tests/user-organization-privacy.test.ts` set a default `SESSION_SECRET` the way `tests/domain.test.ts` does. Verify with `env -u SESSION_SECRET node --import tsx --test tests/user-organization-privacy.test.ts` → PASS.

- [ ] **Step 4: E2E (revised 2026-10-19):** `(erp)/loading.tsx` streams every `(erp)` page, so `notFound()` cannot change the HTTP status from 200 (Next's documented streaming contract). Assert the observable outcome instead: in `e2e/security-http.spec.ts`, log in as admin through `page.request`, then for `/constructor`, `/toString` and `/constructor/00000000-0000-4000-8000-000000000000` expect the heading `페이지를 찾을 수 없습니다.` to be visible and the text `정보를 불러오지 못했습니다.` to have count 0. Run the local e2e runner on `e2e/security-http.spec.ts`.

- [ ] **Step 5: Verify** the Global Constraints checks.

- [ ] **Step 6: Commit** `fix: retry server errors and 404 unknown entity routes` (Steps 1-3), then `test: show the not-found page for inherited-key entity routes` (Step 4).

### Task 7: Correct related-record labels on detail pages

**Files:**
- Modify: `src/lib/records.ts` (`selection()`)
- Modify: `src/components/entity-detail.tsx` (relation label lookup in the field renderer)
- Create: `tests/relation-labels.test.ts`

**Interfaces:**
- Produces: `selection("contracts")` rows gain `predecessor_name`; `selection("components")` and `selection("vms")` rows gain `asset_name`.

- [ ] **Step 1: Write the failing tests** with `isolatedDatabase()` and records created via `saveRecord`: a successor contract's `getRecord` has `predecessor_name` equal to the predecessor's name; a contract without predecessor has `predecessor_name === null`; `getRecord("components", …)` and `getRecord("vms", …)` have `asset_name` equal to the asset's name; `listRecords("components", …)` with `q=<component name>` still finds the row and includes `asset_name`.

- [ ] **Step 2: Run to verify failure:** `node --import tsx --test tests/relation-labels.test.ts`.

- [ ] **Step 3: Implement.** contracts: `LEFT JOIN contracts p ON p.id=e.predecessor_id` selecting `p.name predecessor_name`. Add `components` and `vms` cases selecting `e.*,a.name asset_name` with `JOIN assets a ON a.id=e.asset_id`. In `entity-detail.tsx`, look labels up through one explicit map `{ customer_id: "customer_name", site_id: "site_name", asset_id: "asset_name", owner_id: "owner_name", assignee_id: "assignee_name", predecessor_id: "predecessor_name" }`, with no fallback to an unrelated column (fall back to the raw value only when the mapped label is missing).

- [ ] **Step 4: Verify** the focused test and the Global Constraints checks.

- [ ] **Step 5: Commit** `fix: show correct names for related records`.

---

## Round 2 (controller review rulings, 2026-10-19)

Tasks 8-11 come from the controller's review of Tasks 1-5 (see the SDD ledger rulings). Global Constraints apply unchanged.

### Task 8: Session time zone through the pool hook

Why: rewriting `DATABASE_URL` breaks a password containing a malformed percent escape (pg-connection-string then `encodeURI`s the whole URL and the server receives `-c TimeZone%3DAsia%2FSeoul`), and pg never sends `statement_timeout: 0`.

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `tests/timezone.test.ts`, `tests/migration-connection.test.ts`

**Interfaces:**
- Removes: `withSessionTimeZone` (no callers may remain).
- Produces in `src/lib/db.ts`:
  - `export async function applySessionTimeZone(client: { query: (sql: string) => Promise<unknown> }): Promise<void>` — runs exactly `SET TIME ZONE 'Asia/Seoul'` (built from `DB_TIME_ZONE`).
  - `export function poolConfig(connectionString: string): PoolConfig` returning exactly `{ connectionString, max: 8, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 30000, query_timeout: 35000, onConnect: applySessionTimeZone }`; `connectionString` is passed through unchanged. pg-pool 3.14 awaits `onConnect` before handing out a new connection.
  - `migrationClientConfig(connectionString)` returns exactly `{ connectionString, connectionTimeoutMillis: 10000, lock_timeout: 60000, application_name: "operix-migrate" }`.
  - `connectForMigrations()` runs `applySessionTimeZone(client)` and then `SET statement_timeout = 0` right after `client.connect()`.
- `connect()` builds the pool with `new Pool(poolConfig(process.env.DATABASE_URL))` and PGlite calls `applySessionTimeZone(pg)` right after `waitReady`.

- [ ] **Step 1: Update the tests first:**
  - `applySessionTimeZone` with a recording fake client issues exactly `["SET TIME ZONE 'Asia/Seoul'"]`.
  - `poolConfig(url)` deep-equals the object above (`onConnect` is `applySessionTimeZone`), and `connectionString` is byte-identical to the input for `postgresql://operix:p%ssw0rd!@db:5432/operix` and for `postgresql://u:p@db:5432/operix?options=-c%20search_path%3Dtest_schema&sslmode=disable`.
  - `migrationClientConfig(url)` deep-equals the object above, with neither `query_timeout` nor `statement_timeout` keys.
  - In the stubbed PostgreSQL migration-connection test, the first two statements after connect are `SET TIME ZONE 'Asia/Seoul'` and `SET statement_timeout = 0`.
  - Delete the `withSessionTimeZone` tests; keep every PGlite session, date, contract and report-number test.
- [ ] **Step 2: Run to verify failure:** `node --import tsx --test tests/timezone.test.ts tests/migration-connection.test.ts`.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Verify** the focused tests (also with `TZ=UTC`) and the Global Constraints checks.
- [ ] **Step 5: Commit** `fix: set the database time zone per connection instead of in the URL`.

### Task 9: Seed bootstrap follow-ups

**Files:**
- Modify: `scripts/seed.ts`, `tests/seed.test.ts`, `docs/DEPLOYMENT.md`

**Interfaces:**
- Produces: seed behaviour only.

- [ ] **Step 1: Update the tests first:**
  - With no active admin and an existing non-admin account whose email equals `ADMIN_EMAIL` (run in its own fresh PGlite directory so no other row can collide), the seed exits non-zero with `ADMIN_EMAIL belongs to an existing account that is not an active administrator. Choose another ADMIN_EMAIL.` and creates no admin.
  - Replace the fixed-id collision test: the bootstrap admin's id is a UUID and not `id("admin")` (`operix-demo:admin`-derived).
  - On the skip path, stdout contains `Administrator already exists; bootstrap skipped.` and does not contain `Administrator bootstrap completed`.
- [ ] **Step 2: Run to verify failure:** `node --import tsx --test tests/seed.test.ts`.
- [ ] **Step 3: Implement.** The bootstrap admin gets `crypto.randomUUID()` (grep first: no other code may rely on `id("admin")`). The closing `Administrator bootstrap completed.` line prints only when this run inserted the admin.
- [ ] **Step 4: Docs.** In the `ADMIN_EMAIL / ADMIN_PASSWORD` row of `docs/DEPLOYMENT.md`, add that the NAS Portainer template (`deploy/nas/compose.template.json`) still requires both variables, so keep them in that deployment. *Reworded in the final fix wave: the NAS `migrate` service does not run the seed, so a new NAS stack's first administrator is created out-of-band, and the variables are required there only because the template interpolates them.*
- [ ] **Step 5: Verify** the focused test and the Global Constraints checks.
- [ ] **Step 6: Commit** `fix: tidy admin bootstrap seed identity and output`.

### Task 10: Worker status, stack redaction and notification state

**Files:**
- Modify: `src/lib/error-log.ts`, `src/lib/maintenance.ts`, `scripts/worker.ts`, `src/components/shell.tsx`
- Modify: `tests/error-log.test.ts`

**Interfaces:**
- Produces in `src/lib/maintenance.ts`: `export async function recordMaintenanceOutcome(db: { query: (sql: string, params?: any[]) => Promise<unknown> }, outcome: { failed: string[]; durationMs: number }, log: (line: string) => void = console.error): Promise<boolean>` — performs today's success UPDATE (with `last_duration_ms`) when `failed` is empty, otherwise today's failure UPDATE (`last_error = maintenance_failed:<names>`); it never throws: if the UPDATE fails it logs one JSON line `{ event: "operix.worker.status_failed", ...errorSummary(e) }` and then tries `UPDATE job_runs SET last_error='status_update_failed',started_at=NULL WHERE id='worker'` once more, swallowing (but logging, with `stage: "fallback"`) that failure too. It resolves to `true` only when the primary UPDATE succeeded, and `worker --once` exits 1 otherwise.

- [ ] **Step 1: Write the failing tests:**
  - `errorSummary` of an error with `code "22P02"` and message `invalid input syntax for type uuid: "line1\nat secret@x.y"` (also with leading spaces before `at`) contains no `secret@x.y` anywhere in `JSON.stringify(result)`.
  - `recordMaintenanceOutcome` with a fake db: empty `failed` → one success UPDATE with the duration; `failed ["b"]` → one UPDATE whose parameters include `maintenance_failed:b`; a db whose `query` throws → the call resolves, `log` received the `operix.worker.status_failed` line and the fallback UPDATE was attempted.
- [ ] **Step 2: Run to verify failure:** `node --import tsx --test tests/error-log.test.ts`.
- [ ] **Step 3: Implement.** `stackFrames` looks for the message on the stack's first line without comparing the header's name (pg renames errors after V8 writes the header) and skips the header by counting the message's lines; the first `at ` line is used only when a single-line message is not found there, and an unlocatable multi-line message logs no frames. `scripts/worker.ts` replaces its two inline UPDATE branches with `recordMaintenanceOutcome` (keep the `operix.worker.completed` / `operix.worker.failed` log lines and the `--once` exit code). In `shell.tsx` the "모두 읽음" success path uses a functional update (`setNotifications((current) => current.map(...))`).
- [ ] **Step 4: Verify** the focused test, the local e2e runner on `e2e/notifications.spec.ts`, and the Global Constraints checks.
- [ ] **Step 5: Commit** `fix: harden worker status updates, stack redaction and notification state`.

### Task 11: Shared script test helpers

**Files:**
- Create: `tests/helpers/script-db.ts`
- Modify: `tests/seed.test.ts`, `tests/error-log.test.ts`, `tests/migration-connection.test.ts`

**Interfaces:**
- Produces in `tests/helpers/script-db.ts`: one `runScript` (child process `node --import tsx scripts/<name>.ts` against a PGlite directory, returning `{ code, stdout, stderr }`) and one PGlite-directory helper, unifying the three existing copies. Keep the most widely used existing names and signatures.

- [ ] **Step 1:** Extract the helpers and switch all three files to them without changing any test's behaviour, title or count.
- [ ] **Step 2: Verify** the three files and the Global Constraints checks; the total test count must equal the count before this task.
- [ ] **Step 3: Commit** `test: share the script and PGlite helpers`.
