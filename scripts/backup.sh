#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_root="${1:?Usage: bash scripts/backup.sh /absolute/backup-directory}"
mkdir -p "$backup_root"
backup_dir="$backup_root/operix-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$backup_dir"
# Stop writes so the DB dump and immutable file objects represent one backup point.
docker compose stop web worker
trap 'docker compose start web worker >/dev/null' EXIT
docker compose exec -T db pg_dump -U operix -d operix -Fc > "$backup_dir/database.dump"
docker compose run --rm --no-deps --entrypoint tar web -czf - -C /app/storage . > "$backup_dir/storage.tar.gz"
cp .env "$backup_dir/runtime.env"
git rev-parse HEAD > "$backup_dir/source-commit.txt"
(cd "$backup_dir" && sha256sum database.dump storage.tar.gz runtime.env source-commit.txt > SHA256SUMS)
printf 'Backup completed: %s\n' "$backup_dir"
printf 'Contains credentials. Copy to an access-controlled, encrypted backup destination.\n'
