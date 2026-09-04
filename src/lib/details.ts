import { getDb } from "./db";
import { getRecord, selection } from "./records";
import { can, redact } from "./policy";
import type { User } from "./auth";
export async function details(kind: string, id: string, user: User) {
  const db = await getDb(),
    record = await getRecord(kind, id, user),
    related: Record<string, any[]> = {};
  const queries: [string, string][] = [];
  if (kind === "customers") {
    queries.push(
      ["sites", `${selection("sites")} WHERE e.customer_id=$1`],
      ["assets", `${selection("assets")} WHERE c.id=$1`],
      ["contracts", `${selection("contracts")} WHERE e.customer_id=$1`],
      ["tickets", `${selection("tickets")} WHERE e.customer_id=$1`],
    );
  }
  if (kind === "sites")
    queries.push(["assets", `${selection("assets")} WHERE e.site_id=$1`]);
  if (kind === "assets") {
    queries.push(
      ["components", "SELECT * FROM components WHERE asset_id=$1"],
      ["vms", "SELECT * FROM vms WHERE asset_id=$1"],
      [
        "contracts",
        `${selection("contracts")} WHERE e.id IN (SELECT contract_id FROM contract_assets WHERE asset_id=$1)`,
      ],
      ["inspections", `${selection("inspections")} WHERE e.asset_id=$1`],
      [
        "tickets",
        `${selection("tickets")} WHERE e.id IN (SELECT ticket_id FROM ticket_assets WHERE asset_id=$1)`,
      ],
    );
  }
  if (kind === "contracts")
    queries.push([
      "assets",
      `${selection("assets")} WHERE e.id IN (SELECT asset_id FROM contract_assets WHERE contract_id=$1)`,
    ]);
  if (kind === "tickets")
    queries.push([
      "assets",
      `${selection("assets")} WHERE e.id IN (SELECT asset_id FROM ticket_assets WHERE ticket_id=$1)`,
    ]);
  if (kind === "maintenance_plans")
    queries.push([
      "inspections",
      `${selection("inspections")} WHERE e.plan_id=$1`,
    ]);
  await Promise.all(
    queries.map(async ([key, sql]) => {
      related[key] = (
        await db.query(sql + " ORDER BY created_at DESC LIMIT 100", [id])
      ).map((r) => redact(r, user.role));
    }),
  );
  const [entries, documents, reports, history] = await Promise.all([
    db.query(
      "SELECT e.*,u.name user_name FROM entries e JOIN users u ON u.id=e.user_id WHERE entity_kind=$1 AND entity_id=$2 ORDER BY e.created_at DESC",
      [kind, id],
    ),
    db.query(
      "SELECT id,name,mime_type,size_bytes,created_at FROM documents WHERE entity_kind=$1 AND entity_id=$2 ORDER BY created_at DESC",
      [kind, id],
    ),
    db.query(
      "SELECT id,title,revision,created_at FROM reports WHERE entity_kind=$1 AND entity_id=$2 ORDER BY revision DESC",
      [kind, id],
    ),
    can(user.role, "audit")
      ? db.query(
          "SELECT a.*,u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE entity_kind=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 50",
          [kind, id],
        )
      : Promise.resolve([]),
  ]);
  return { record, related, entries, documents, reports, history };
}
