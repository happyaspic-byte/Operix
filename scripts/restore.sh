#!/usr/bin/env bash
set -euo pipefail
backup_dir="${1:?Usage: CONFIRM_RESTORE=YES bash scripts/restore.sh /absolute/backup-directory}"
if [[ "${CONFIRM_RESTORE:-}" != "YES" ]]; then
  printf 'Restore replaces the target database. Use a separate recovery environment first. Set CONFIRM_RESTORE=YES to proceed.\n' >&2
  exit 1
fi
(cd "$backup_dir" && sha256sum -c SHA256SUMS)
docker compose stop web worker
# Keep writers stopped on failure; investigate before bringing the service back.
docker compose exec -T db pg_restore -U operix -d operix --clean --if-exists --no-owner --exit-on-error < "$backup_dir/database.dump"
docker compose run --rm --no-deps --entrypoint tar web -xzf - -C /app/storage < "$backup_dir/storage.tar.gz"
docker compose start web worker
printf 'Restore completed. Verify login, record counts, documents and report snapshots.\n'
