import { catalog } from "./catalog";
import { getDb } from "./db";
import { getRecord } from "./records";
import { queryDate } from "./http";
import { AppError, can } from "./policy";
import type { User } from "./auth";

const kinds = ["assets", "components", "vms"];
const excluded =
  /password|passwd|secret|token|credential|^version$|(^|_)(created|updated|deleted)_at$/i;

export function historySnapshot(
  kind: string,
  row: Record<string, any> | undefined,
) {
  if (!row || !kinds.includes(kind)) return null;
  return Object.fromEntries(
    catalog[kind].fields
      .filter((f) => !excluded.test(f.key))
      .map((f) => [f.key, row[f.key] ?? null]),
  );
}

function fields(
  kind: string,
  before: Record<string, any> | null,
  after: Record<string, any> | null,
  user: User,
) {
  return catalog[kind].fields
    .filter(
      (f) =>
        !excluded.test(f.key) &&
        (!f.permission || can(user.role, f.permission)),
    )
    .flatMap((f) => {
      const a = before?.[f.key] ?? null,
        b = after?.[f.key] ?? null;
      return JSON.stringify(a) === JSON.stringify(b)
        ? []
        : [{ key: f.key, label: f.label, before: a, after: b }];
    });
}

export async function assetHistory(
  id: string,
  user: User,
  query: URLSearchParams,
) {
  if (!can(user.role, "audit"))
    throw new AppError(403, "감사 이력 권한이 필요합니다.");
  const db = await getDb();
  await getRecord("assets", id, user, db, true);
  const number = (
    key: string,
    fallback: number,
    max: number,
    zero: boolean,
  ) => {
    const raw = query.get(key);
    if (raw === null) return fallback;
    if (
      !(zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) > max
    )
      throw new AppError(400, `${key} 범위를 확인해 주세요.`);
    return Number(raw);
  };
  const limit = number("limit", 20, 100, false),
    offset = number("offset", 0, 10000000, true);
  const from = query.get("from"),
    to = query.get("to"),
    compare = query.get("compare");
  if (from !== null) queryDate(from);
  if (to !== null) queryDate(to);
  if (from && to && from > to)
    throw new AppError(400, "날짜 범위를 확인해 주세요.");
  let dates: string[] | null = null;
  if (compare !== null) {
    dates = compare.split(",");
    if (dates.length !== 2)
      throw new AppError(400, "비교 날짜 두 개가 필요합니다.");
    dates.forEach(queryDate);
    if (dates[0] > dates[1])
      throw new AppError(400, "날짜 순서를 확인해 주세요.");
  }
  const rows = await db.query(
    `SELECT a.*, u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    WHERE (a.entity_kind='assets' AND a.entity_id=$1)
       OR (a.entity_kind IN ('components','vms') AND (a.entity_id IN (SELECT id FROM components WHERE asset_id=$1 UNION SELECT id FROM vms WHERE asset_id=$1) OR a.details->'before'->>'asset_id'=$1 OR a.details->'after'->>'asset_id'=$1))
    ORDER BY a.created_at, a.id`,
    [id],
  );
  const end = (date: string) =>
    new Date(`${date}T23:59:59.999+09:00`).getTime();
  const start = (date: string) => new Date(`${date}T00:00:00+09:00`).getTime();
  const events = rows.flatMap((row) => {
    const stamp = new Date(row.created_at).getTime();
    if ((from && stamp < start(from)) || (to && stamp > end(to))) return [];
    const details = row.details || {};
    const redacted = Boolean(details.redacted);
    const available =
      Object.hasOwn(details, "before") && Object.hasOwn(details, "after");
    if (
      row.entity_kind !== "assets" &&
      available &&
      details.before?.asset_id !== id &&
      details.after?.asset_id !== id
    )
      return [];
    const diffs = available
      ? fields(row.entity_kind, details.before, details.after, user).filter(
          (diff) =>
            row.entity_kind === "assets" ||
            !details.before ||
            !details.after ||
            (details.before.asset_id === id && details.after.asset_id === id) ||
            diff.key === "asset_id",
        )
      : [];
    if (available && !diffs.length) return [];
    return [
      {
        id: row.id,
        timestamp: row.created_at,
        actor: row.user_name || "시스템",
        kind: row.entity_kind,
        label: catalog[row.entity_kind].singular,
        action: row.action,
        diffs,
        unavailable: !available,
        redacted,
      },
    ];
  });
  const contexts = await db.query(
    `SELECT 'tickets' kind, t.id, t.name, t.created_at FROM tickets t JOIN ticket_assets ta ON ta.ticket_id=t.id WHERE ta.asset_id=$1
    UNION ALL SELECT 'inspections' kind, i.id, i.name, i.created_at FROM inspections i WHERE i.deleted_at IS NULL AND (i.asset_id=$1 OR EXISTS (SELECT 1 FROM inspection_assets ia WHERE ia.inspection_id=i.id AND ia.asset_id=$1))`,
    [id],
  );
  for (const row of contexts) {
    const stamp = new Date(row.created_at).getTime();
    if ((from && stamp < start(from)) || (to && stamp > end(to))) continue;
    events.push({
      id: `context:${row.kind}:${row.id}`,
      timestamp: row.created_at,
      actor: "",
      kind: row.kind,
      label: `${catalog[row.kind].singular}: ${row.name}`,
      action: "context",
      diffs: [],
      unavailable: false,
      redacted: false,
    });
  }
  const workHistory = await db.query(
    `SELECT a.id, a.created_at, a.action, a.entity_kind, u.name user_name, COALESCE(t.name,i.name) name
    FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    LEFT JOIN tickets t ON a.entity_kind='tickets' AND t.id=a.entity_id
    LEFT JOIN inspections i ON a.entity_kind='inspections' AND i.id=a.entity_id
    WHERE a.action<>'create' AND ((t.id IN (SELECT ticket_id FROM ticket_assets WHERE asset_id=$1)) OR (i.deleted_at IS NULL AND (i.asset_id=$1 OR i.id IN (SELECT inspection_id FROM inspection_assets WHERE asset_id=$1))))`,
    [id],
  );
  for (const row of workHistory) {
    const stamp = new Date(row.created_at).getTime();
    if ((from && stamp < start(from)) || (to && stamp > end(to))) continue;
    events.push({
      id: `context-audit:${row.id}`,
      timestamp: row.created_at,
      actor: row.user_name || "시스템",
      kind: row.entity_kind,
      label: `${catalog[row.entity_kind].singular}: ${row.name}`,
      action: "context",
      diffs: [],
      unavailable: false,
      redacted: false,
    });
  }
  events.sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() ||
      a.id.localeCompare(b.id),
  );
  let comparison = null;
  if (dates) {
    const stateAt = (date: string) => {
      const state: Record<
        string,
        {
          kind: string;
          values: Record<string, any> | null;
          unavailable: boolean;
        }
      > = {};
      for (const row of rows) {
        if (new Date(row.created_at).getTime() > end(date)) break;
        const d = row.details || {},
          key = `${row.entity_kind}:${row.entity_id}`;
        if (
          row.entity_kind !== "assets" &&
          d.after &&
          d.after.asset_id !== id
        ) {
          delete state[key];
          continue;
        }
        if (d.redacted || !Object.hasOwn(d, "after"))
          state[key] = {
            kind: row.entity_kind,
            values: null,
            unavailable: true,
          };
        else
          state[key] = {
            kind: row.entity_kind,
            values: d.after,
            unavailable: false,
          };
      }
      return state;
    };
    const left = stateAt(dates[0]),
      right = stateAt(dates[1]);
    const records = [
      ...new Set([...Object.keys(left), ...Object.keys(right)]),
    ].map((key) => {
      const a = left[key],
        b = right[key],
        kind = (a || b).kind;
      const unavailable = !a || !b || a.unavailable || b.unavailable;
      const visible = (values: Record<string, any> | null | undefined) =>
        values
          ? Object.fromEntries(
              catalog[kind].fields
                .filter(
                  (f) =>
                    !excluded.test(f.key) &&
                    (!f.permission || can(user.role, f.permission)),
                )
                .map((f) => [f.key, values[f.key] ?? null]),
            )
          : null;
      return {
        id: key,
        kind,
        label: catalog[kind].singular,
        before: visible(a?.values),
        after: visible(b?.values),
        unavailable,
        diffs: unavailable ? [] : fields(kind, a.values, b.values, user),
      };
    });
    comparison = { dates, records };
  }
  return {
    events: events.slice(offset, offset + limit),
    total: events.length,
    limit,
    offset,
    comparison,
  };
}
