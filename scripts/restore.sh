#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_dir="${1:?Usage: CONFIRM_RESTORE=YES BACKUP_AGE_IDENTITY=/path/to/key bash scripts/restore.sh /absolute/backup-directory}"
[[ "${CONFIRM_RESTORE:-}" == YES ]] || { printf 'Set CONFIRM_RESTORE=YES for the intended recovery environment.\n' >&2; exit 1; }
(cd "$backup_dir" && sha256sum -c SHA256SUMS)
restore_stage=$(mktemp -d)
trap 'rm -rf -- "$restore_stage"' EXIT
if [[ -f "$backup_dir/backup.tar.gz.age" ]]; then
  age -d -i "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY is required}" "$backup_dir/backup.tar.gz.age" > "$restore_stage/archive.tar.gz"
elif [[ "${OPERIX_CONTAINER_TEST:-}" == 1 ]]; then cp "$backup_dir/backup.tar.gz" "$restore_stage/archive.tar.gz"
else printf 'Unencrypted production backup rejected.\n' >&2; exit 1
fi
# Reject traversal, symlinks, devices and unexpected archive members before extraction.
python3 - "$restore_stage" <<'PY'
import pathlib,sys,tarfile
stage=pathlib.Path(sys.argv[1]); allowed={'database.dump','storage.tar.gz','manifest.json','tombstones.json','runtime.env','source-commit.txt','backup-id.txt','SHA256SUMS'}
with tarfile.open(stage/'archive.tar.gz') as archive:
    for m in archive:
        n=m.name.removeprefix('./')
        if m.isdir() and n in ('','.'): continue
        if not m.isfile() or n not in allowed: raise SystemExit('Unexpected backup archive member')
    archive.extractall(stage,filter='data')
with tarfile.open(stage/'storage.tar.gz') as archive:
    for m in archive:
        n=m.name.removeprefix('./')
        if m.isdir() and n in ('','.'): continue
        import re
        if not m.isfile() or not re.fullmatch(r'[a-f0-9-]{36}',n): raise SystemExit('Unexpected storage archive member')
PY
(cd "$restore_stage" && sha256sum -c SHA256SUMS)
docker compose run --rm --no-deps -T web node --import tsx scripts/recovery.ts validate-schema < "$restore_stage/manifest.json"
docker compose stop web worker
# Failure from this point leaves writers stopped. Do not restart until investigation.
docker compose run --rm --no-deps -T web node --import tsx scripts/recovery.ts tombstones > "$restore_stage/current-tombstones.json"
restore_volume="operix_recovery_$(date -u +%Y%m%dT%H%M%SZ)_$RANDOM"
docker volume create "$restore_volume" >/dev/null
OPERIX_UPLOAD_VOLUME="$restore_volume" docker compose run --rm --no-deps -T --entrypoint tar web -xzf - -C /app/storage/uploads < "$restore_stage/storage.tar.gz"
docker compose exec -T db pg_restore -U operix -d operix --clean --if-exists --no-owner --exit-on-error --single-transaction < "$restore_stage/database.dump"
OPERIX_UPLOAD_VOLUME="$restore_volume" docker compose run --rm --no-deps -T web node --import tsx scripts/recovery.ts verify < "$restore_stage/manifest.json"
# Re-apply erasures performed after this backup before permitting access.
OPERIX_UPLOAD_VOLUME="$restore_volume" docker compose run --rm --no-deps -T web node --import tsx scripts/recovery.ts replay < "$restore_stage/current-tombstones.json"
python3 - "$restore_volume" <<'PY'
from pathlib import Path
import sys,os
p=Path('.env'); rows=[x for x in p.read_text().splitlines() if not x.startswith('OPERIX_UPLOAD_VOLUME=')];rows.append('OPERIX_UPLOAD_VOLUME='+sys.argv[1]);tmp=p.with_name('.env.restore-tmp');tmp.write_text('\n'.join(rows)+'\n');os.chmod(tmp,0o600);tmp.replace(p)
PY
docker compose up -d --no-deps --force-recreate web worker
printf 'Restore verified. Previous upload volume retained for controlled disposal; new clean volume: %s\n' "$restore_volume"
