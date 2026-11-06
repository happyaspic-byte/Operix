import { getDb } from "./db";
import type { User } from "./auth";
import { todayKST, addDays } from "./dates";
import { can, redact } from "./policy";
import { selection } from "./records";
// Dashboard contracts: active dated contracts not yet renewed or ended.
const openContracts =
  "FROM contracts c JOIN customers cu ON cu.id=c.customer_id LEFT JOIN users u ON u.id=c.owner_id WHERE c.status='active' AND c.term='dated' AND c.renewal NOT IN ('renewed','ended')";
const contractColumns =
  "SELECT c.*,u.name owner_name,cu.name customer_name,(SELECT count(*)::int FROM contract_assets ca WHERE ca.contract_id=c.id) asset_count";
export async function overview(user: User) {
  const db = await getDb(),
    today = todayKST();
  const [
    counts,
    assets,
    upcoming,
    expired,
    expiryCounts,
    inspections,
    tickets,
    activity,
  ] = await Promise.all([
    db.query(
      `SELECT (SELECT count(*)::int FROM customers WHERE status='active') customers,(SELECT count(*)::int FROM assets WHERE status<>'archived') assets,(SELECT count(*)::int FROM tickets WHERE status NOT IN ('resolved','closed')) tickets,(SELECT count(*)::int FROM inspections WHERE deleted_at IS NULL AND status IN ('scheduled','in_progress') AND planned_date<$1) overdue`,
      [today],
    ),
    db.query(
      "SELECT status,count(*)::int count FROM assets WHERE status<>'archived' GROUP BY status",
    ),
    db.query(
      `${contractColumns} ${openContracts} AND c.end_date>=$1 AND c.end_date<=$2 ORDER BY c.end_date,c.name LIMIT 8`,
      [today, addDays(today, 90)],
    ),
    db.query(
      `${contractColumns} ${openContracts} AND c.end_date<$1 ORDER BY c.end_date DESC,c.name LIMIT 5`,
      [today],
    ),
    // Expired assets: linked to an expired open contract and to no active
    // contract that still runs (or has a perpetual/unknown term).
    db.query(
      `SELECT (SELECT count(*)::int ${openContracts} AND c.end_date<$1) expired,
        (SELECT count(*)::int ${openContracts} AND c.end_date BETWEEN $1 AND $2) within30,
        (SELECT count(*)::int ${openContracts} AND c.end_date>$2 AND c.end_date<=$3) within90,
        (SELECT count(DISTINCT ca.asset_id)::int FROM contract_assets ca JOIN contracts c ON c.id=ca.contract_id JOIN assets a ON a.id=ca.asset_id
          WHERE a.status<>'archived' AND c.status='active' AND c.term='dated' AND c.renewal NOT IN ('renewed','ended') AND c.end_date<$1
          AND NOT EXISTS (SELECT 1 FROM contract_assets ca2 JOIN contracts c2 ON c2.id=ca2.contract_id
            WHERE ca2.asset_id=ca.asset_id AND c2.status='active' AND (c2.term<>'dated' OR c2.end_date>=$1))) expired_assets`,
      [today, addDays(today, 30), addDays(today, 90)],
    ),
    db.query(
      `${selection("inspections")} WHERE e.deleted_at IS NULL AND e.status IN ('scheduled','in_progress') ORDER BY e.planned_date,e.id LIMIT 5`,
    ),
    db.query(
      "SELECT t.*,c.name customer_name,u.name assignee_name FROM tickets t JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=t.assignee_id WHERE t.status NOT IN ('resolved','closed') ORDER BY CASE t.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,t.updated_at DESC LIMIT 4",
    ),
    can(user.role, "audit")
      ? db.query(
          "SELECT a.id,a.action,a.entity_kind,a.entity_id,a.created_at,u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 5",
        )
      : Promise.resolve([]),
  ]);
  return {
    today,
    counts: counts[0],
    assetStatus: assets,
    expiry: {
      counts: expiryCounts[0],
      upcoming: upcoming.map((c) => redact(c, user.role)),
      expired: expired.map((c) => redact(c, user.role)),
    },
    inspections,
    tickets,
    activity,
  };
}
