import { getDb } from "./db";
import { getRecord, selection } from "./records";
import { can, redact } from "./policy";
import { pagination } from "./http";
import { readableClasses } from "./document-policy";
import type { User } from "./auth";
export async function details(
  kind: string,
  id: string,
  user: User,
  query = new URLSearchParams(),
) {
  const db = await getDb(),
    record = await getRecord(kind, id, user),
    related: Record<string, any[]> = {};
  const page = pagination(query),
    totals: Record<string, number> = {},
    section = query.get("section") || "overview";
  async function paged(
    key: string,
    sql: string,
    values: unknown[],
    column = "name",
  ) {
    const filter =
      section === key && query.get("q")
        ? ` WHERE ${column} ILIKE $${values.length + 1}`
        : "";
    const ps = filter
      ? [...values, "%" + query.get("q")!.slice(0, 150) + "%"]
      : values;
    const base = `SELECT * FROM (${sql}) related${filter}`;
    const [count] = await db.query(
      `SELECT count(*)::int total FROM (${base}) counted`,
      ps,
    );
    totals[key] = count.total;
    return db.query(
      base +
        ` ORDER BY created_at DESC,id LIMIT $${ps.length + 1} OFFSET $${ps.length + 2}`,
      [
        ...ps,
        page.limit,
        section === key ||
        (section === "documents" && ["documents", "reports"].includes(key))
          ? page.offset
          : 0,
      ],
    );
  }
  const queries: [string, string][] = [];
  if (kind === "customers") {
    queries.push(
      [
        "customer_contacts",
        `${selection("customer_contacts")} WHERE e.customer_id=$1`,
      ],
      ["sites", `${selection("sites")} WHERE e.customer_id=$1`],
      ["assets", `${selection("assets")} WHERE c.id=$1`],
      ["contracts", `${selection("contracts")} WHERE e.customer_id=$1`],
      ["tickets", `${selection("tickets")} WHERE e.customer_id=$1`],
    );
  }
  if (kind === "sites")
    queries.push(
      [
        "customer_contacts",
        `${selection("customer_contacts")} WHERE e.site_id=$1`,
      ],
      ["assets", `${selection("assets")} WHERE e.site_id=$1`],
    );
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
      related[key] = (await paged(key, sql, [id])).map((r) =>
        redact(r, user.role),
      );
    }),
  );
  const [entries, documents, reports, history] = await Promise.all([
    paged(
      "timeline",
      "SELECT e.*,u.name user_name FROM entries e JOIN users u ON u.id=e.user_id WHERE entity_kind=$1 AND entity_id=$2 ORDER BY e.created_at DESC",
      [kind, id],
      "body",
    ),
    paged(
      "documents",
      "SELECT id,name,mime_type,size_bytes,created_at,classification,scan_status,version FROM documents WHERE entity_kind=$1 AND entity_id=$2 AND deleted_at IS NULL AND classification=ANY($3::text[])",
      [kind, id, readableClasses(user.role)],
    ),
    paged(
      "reports",
      "SELECT id,title,revision,created_at FROM reports WHERE entity_kind=$1 AND entity_id=$2 AND withdrawn_at IS NULL AND classification=ANY($3::text[])",
      [kind, id, readableClasses(user.role)],
      "title",
    ),
    can(user.role, "audit")
      ? paged(
          "history",
          "SELECT a.*,u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE entity_kind=$1 AND entity_id=$2",
          [kind, id],
          "action",
        )
      : Promise.resolve([]),
  ]);
  return {
    record,
    related,
    entries,
    documents,
    reports,
    history,
    totals,
    page: page.page,
    limit: page.limit,
  };
}
