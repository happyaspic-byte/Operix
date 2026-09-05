#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${BACKUP_ROOT:?Set BACKUP_ROOT}"
: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT}"
: "${BACKUP_REMOTE:?Set a restricted rsync destination, such as backup-host:/backups/operix}"
command -v age >/dev/null
command -v rsync >/dev/null
# A per-run destination avoids selecting another process's backup files.
run_root="$BACKUP_ROOT/scheduled-$(date -u +%Y%m%dT%H%M%SZ)"
bash scripts/backup.sh "$run_root"
rsync --archive --checksum --mkpath --chmod=D700,F600 -- "$run_root/" "$BACKUP_REMOTE/"
printf 'Encrypted backup copied successfully to the configured remote.\n'
