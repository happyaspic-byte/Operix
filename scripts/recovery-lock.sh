#!/usr/bin/env bash
# All backup and restore commands for a deployment must use the same checkout.
# Keep the lock file: unlinking it would let contenders lock different inodes.
command -v flock >/dev/null || { printf 'Install flock before running recovery.\n' >&2; exit 1; }
exec 9>.operix-recovery.lock
flock -n 9 || { printf 'Another backup or restore is running for this deployment.\n' >&2; exit 1; }
