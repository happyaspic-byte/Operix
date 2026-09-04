import { getDb } from "./db";
import type { User } from "./auth";
import { todayKST, addDays } from "./dates";
import { redact } from "./policy";
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
        "SELECT i.*,a.name asset_name,c.name customer_name,u.name assignee_name FROM inspections i JOIN assets a ON a.id=i.asset_id JOIN sites s ON s.id=a.site_id JOIN customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=i.assignee_id WHERE i.status IN ('scheduled','in_progress') ORDER BY i.planned_date LIMIT 5",
      ),
      db.query(
        "SELECT t.*,c.name customer_name,u.name assignee_name FROM tickets t JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=t.assignee_id WHERE t.status NOT IN ('resolved','closed') ORDER BY CASE t.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,t.updated_at DESC LIMIT 4",
      ),
      db.query(
        "SELECT a.id,a.action,a.entity_kind,a.entity_id,a.created_at,u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 5",
      ),
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
