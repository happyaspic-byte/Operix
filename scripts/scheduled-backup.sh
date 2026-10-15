#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${BACKUP_ROOT:?Set BACKUP_ROOT}"
: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT}"
: "${BACKUP_REMOTE:?Set a restricted rsync destination, such as backup-host:/backups/operix}"
command -v age >/dev/null
command -v rsync >/dev/null
# A per-run destination avoids selecting another process's backup files.
mkdir -p "$BACKUP_ROOT"
run_root=$(mktemp -d "$BACKUP_ROOT/scheduled-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
bash scripts/backup.sh "$run_root"
rsync --archive --checksum --mkpath --chmod=D700,F600 -- "$run_root/" "$BACKUP_REMOTE/"
mapfile -t receipts < <(find "$run_root" -type f -name BACKUP_ID)
[[ ${#receipts[@]} == 1 ]] || { printf 'Expected exactly one backup receipt.\n' >&2; exit 1; }
backup_id=$(cat "${receipts[0]}")
[[ "$backup_id" =~ ^[a-f0-9-]{36}$ ]] || exit 1
docker compose run --rm --no-deps web node --import tsx scripts/recovery.ts backup-replicated "$backup_id" >/dev/null
printf 'Encrypted backup copied successfully to the configured remote.\n'
