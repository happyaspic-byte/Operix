#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${CI:-}" == true && "${OPERIX_CONTAINER_TEST:-}" == 1 ]] || { printf 'Disposable CI only.\n' >&2; exit 1; }
backup_dir="${1:?Disposable encrypted backup directory required}"
[[ "$backup_dir" == /tmp/operix-ci-backups/operix-* ]] || exit 1
invalid_stage=$(mktemp -d /tmp/operix-ci-invalid-stage-XXXXXX)
invalid_backup=$(mktemp -d /tmp/operix-ci-invalid-backup-XXXXXX)
trap 'rm -rf -- "$invalid_stage" "$invalid_backup"' EXIT
# A different schema must be rejected before touching database or files.
if printf '%s' '{"version":1,"schemas":[],"files":[]}' | docker compose run --rm --no-deps -T web node --import tsx scripts/recovery.ts validate-schema; then
  printf 'Schema mismatch was accepted.\n' >&2
  exit 1
fi
age -d -i "${BACKUP_AGE_IDENTITY:?}" "$backup_dir/backup.tar.gz.age" | tar -xzf - -C "$invalid_stage"
python3 - "$invalid_stage/manifest.json" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); m=json.loads(p.read_text()); assert m['files']
m['files'][0]['sha256']='0'*64
p.write_text(json.dumps(m))
PY
(cd "$invalid_stage" && sha256sum database.dump storage.tar.gz manifest.json tombstones.json runtime.env source-commit.txt backup-id.txt > SHA256SUMS)
tar -czf - -C "$invalid_stage" . | age -r "${BACKUP_AGE_RECIPIENT:?}" -o "$invalid_backup/backup.tar.gz.age"
(cd "$invalid_backup" && sha256sum backup.tar.gz.age > SHA256SUMS)
if CONFIRM_RESTORE=YES bash scripts/restore.sh "$invalid_backup"; then
  printf 'Incorrect document manifest was accepted.\n' >&2
  exit 1
fi
python3 - <<'PY'
import subprocess
running=subprocess.check_output(['docker','compose','ps','--services','--status','running'],text=True).splitlines()
assert 'web' not in running and 'worker' not in running, 'Failed restore must leave writers stopped'
PY
printf 'Schema mismatch rejected; invalid manifest rejected; writers remained stopped.\n'
