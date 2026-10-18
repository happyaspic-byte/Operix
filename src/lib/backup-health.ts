type Backup = {
  completed_at?: string | null;
  replicated_at?: string | null;
  encrypted?: boolean;
};
export function backupHealth(
  local: Backup | null,
  remote: Backup | null,
  options: {
    localRequired: boolean;
    remoteRequired: boolean;
    maximumAgeHours: number;
    now?: number;
  },
) {
  const now = options.now ?? Date.now();
  const fresh = (value?: string | null) =>
    !!value &&
    Date.parse(value) <= now &&
    now - Date.parse(value) < options.maximumAgeHours * 3600000;
  const localOk = !!local?.encrypted && fresh(local.completed_at);
  // Copying an old archive today does not make its recovery point fresh.
  const remoteOk =
    !!remote?.encrypted &&
    fresh(remote.completed_at) &&
    fresh(remote.replicated_at);
  return {
    ok:
      (!options.localRequired || localOk) &&
      (!options.remoteRequired || remoteOk),
    required: options.localRequired,
    maximum_age_hours: options.maximumAgeHours,
    local_ok: localOk,
    last_success: local?.completed_at ?? null,
    remote: {
      required: options.remoteRequired,
      ok: remoteOk,
      last_success: remote?.replicated_at ?? null,
      recovery_point: remote?.completed_at ?? null,
    },
  };
}
