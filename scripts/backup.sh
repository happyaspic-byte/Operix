#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_root="${1:?Usage: BACKUP_AGE_RECIPIENT=age1... bash scripts/backup.sh /absolute/backup-directory}"
if [[ -z "${BACKUP_AGE_RECIPIENT:-}" && "${OPERIX_CONTAINER_TEST:-}" != "1" ]]; then
  printf 'Set BACKUP_AGE_RECIPIENT. Production backups must be encrypted.\n' >&2
  exit 1
fi
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then command -v age >/dev/null; fi
mkdir -p "$backup_root"
backup_dir="$backup_root/operix-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
mkdir "$backup_dir"
backup_stage=$(mktemp -d)
backup_id=$(cat /proc/sys/kernel/random/uuid)
backup_ok=0
cleanup() {
  rm -rf -- "$backup_stage"
  if [[ "$backup_ok" == 0 ]]; then docker compose run --rm --no-deps web node --import tsx scripts/recovery.ts backup-failed "$backup_id" >/dev/null || true; fi
  docker compose start web worker >/dev/null
}
trap cleanup EXIT
docker compose run --rm --no-deps web node --import tsx scripts/recovery.ts backup-start "$backup_id" >/dev/null
docker compose stop web worker
# Manifest creation rejects orphan files and inconsistent DB metadata.
docker compose run --rm --no-deps -T web node --import tsx scripts/recovery.ts manifest > "$backup_stage/manifest.json"
docker compose exec -T db pg_dump -U operix -d operix -Fc > "$backup_stage/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar web -czf - -C /app/storage/uploads . > "$backup_stage/storage.tar.gz"
docker compose run --rm --no-deps -T web node --import tsx scripts/recovery.ts tombstones > "$backup_stage/tombstones.json"
cp .env "$backup_stage/runtime.env"
git rev-parse HEAD > "$backup_stage/source-commit.txt"
printf '%s' "$backup_id" > "$backup_stage/backup-id.txt"
(cd "$backup_stage" && sha256sum database.dump storage.tar.gz manifest.json tombstones.json runtime.env source-commit.txt backup-id.txt > SHA256SUMS)
backup_mode=encrypted
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  tar -czf - -C "$backup_stage" . | age -r "$BACKUP_AGE_RECIPIENT" -o "$backup_dir/backup.tar.gz.age"
else
  backup_mode=plain
  tar -czf "$backup_dir/backup.tar.gz" -C "$backup_stage" .
fi
(cd "$backup_dir" && sha256sum backup.tar.gz* > SHA256SUMS)
backup_hash=$(sha256sum "$backup_stage/manifest.json" | cut -d ' ' -f 1)
docker compose run --rm --no-deps web node --import tsx scripts/recovery.ts backup-complete "$backup_id" "$backup_hash" "$backup_mode" >/dev/null
backup_ok=1
printf 'Backup completed: %s\n' "$backup_dir"
