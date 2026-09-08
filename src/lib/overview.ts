import { getDb } from "./db";
import type { User } from "./auth";
import { todayKST, addDays } from "./dates";
import { can, redact } from "./policy";
import { selection } from "./records";
export async function overview(user: User) {
  const db = await getDb(),
    today = todayKST();
  const [counts, assets, contracts, inspections, tickets, activity] =
    await Promise.all([
      db.query(
        `SELECT (SELECT count(*)::int FROM customers WHERE status='active') customers,(SELECT count(*)::int FROM assets WHERE status<>'archived') assets,(SELECT count(*)::int FROM tickets WHERE status NOT IN ('resolved','closed')) tickets,(SELECT count(*)::int FROM inspections WHERE status IN ('scheduled','in_progress') AND planned_date<$1) overdue`,
        [today],
      ),
      db.query(
        "SELECT status,count(*)::int count FROM assets WHERE status<>'archived' GROUP BY status",
      ),
      db.query(
        "SELECT c.*,u.name owner_name,cu.name customer_name FROM contracts c JOIN customers cu ON cu.id=c.customer_id LEFT JOIN users u ON u.id=c.owner_id WHERE c.status='active' AND c.term='dated' AND c.renewal NOT IN ('renewed','ended') AND c.end_date<=$1 ORDER BY c.end_date LIMIT 5",
        [addDays(today, 90)],
      ),
      db.query(
        `${selection("inspections")} WHERE e.status IN ('scheduled','in_progress') ORDER BY e.planned_date,e.id LIMIT 5`,
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
    contracts: contracts.map((c) => redact(c, user.role)),
    inspections,
    tickets,
    activity,
  };
}
