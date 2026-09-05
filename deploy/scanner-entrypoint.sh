#!/bin/sh
set -eu
scanner_config=/etc/clamav/clamd.conf
# Preserve upstream defaults and database updates; override only bounded scan policy.
test -f "$scanner_config"
for scanner_key in AlertEncrypted AlertExceedsMax StreamMaxLength MaxScanSize MaxFileSize MaxFiles MaxRecursion MaxThreads MaxQueue MaxScanTime; do
  sed -i "/^${scanner_key}[[:space:]]/d" "$scanner_config"
done
cat >> "$scanner_config" <<'CONF'
AlertEncrypted yes
AlertExceedsMax yes
StreamMaxLength 21M
MaxScanSize 64M
MaxFileSize 21M
MaxFiles 2000
MaxRecursion 8
MaxThreads 4
MaxQueue 8
MaxScanTime 15000
CONF
exec /init "$@"
