import { catalog } from "./catalog";
import { classifications } from "./document-policy";
import { queryDate } from "./http";
import { AppError } from "./policy";

// Resolve polymorphic document targets through their owning customer. EXISTS
// avoids multiplying rows (and totals) when an entity has multiple relations.
function customerCondition(alias: "d" | "r", parameter: string) {
  return `(
    (${alias}.entity_kind='customers' AND ${alias}.entity_id=${parameter}) OR
    (${alias}.entity_kind='sites' AND EXISTS (SELECT 1 FROM sites s WHERE s.id=${alias}.entity_id AND s.customer_id=${parameter})) OR
    (${alias}.entity_kind='customer_contacts' AND EXISTS (SELECT 1 FROM customer_contacts c WHERE c.id=${alias}.entity_id AND c.customer_id=${parameter})) OR
    (${alias}.entity_kind='assets' AND EXISTS (SELECT 1 FROM assets a JOIN sites s ON s.id=a.site_id WHERE a.id=${alias}.entity_id AND s.customer_id=${parameter})) OR
    (${alias}.entity_kind IN ('components','vms','maintenance_plans') AND EXISTS (
      SELECT 1 FROM (
        SELECT id,asset_id,'components' AS kind FROM components
        UNION ALL SELECT id,asset_id,'vms' FROM vms
        UNION ALL SELECT id,asset_id,'maintenance_plans' FROM maintenance_plans
      ) e JOIN assets a ON a.id=e.asset_id JOIN sites s ON s.id=a.site_id
      WHERE e.kind=${alias}.entity_kind AND e.id=${alias}.entity_id AND s.customer_id=${parameter}
    )) OR
    (${alias}.entity_kind='contracts' AND EXISTS (SELECT 1 FROM contracts c WHERE c.id=${alias}.entity_id AND c.customer_id=${parameter})) OR
    (${alias}.entity_kind='tickets' AND EXISTS (SELECT 1 FROM tickets t WHERE t.id=${alias}.entity_id AND t.customer_id=${parameter})) OR
    (${alias}.entity_kind='inspections' AND EXISTS (SELECT 1 FROM inspections i JOIN assets a ON a.id=i.asset_id JOIN sites s ON s.id=a.site_id WHERE i.id=${alias}.entity_id AND s.customer_id=${parameter}))
  )`;
}

export function documentSearchFilters(
  query: URLSearchParams,
  alias: "d" | "r",
  values: unknown[],
  where: string[],
) {
  const add = (column: string, value: string) => {
    values.push(value);
    where.push(`${alias}.${column}=$${values.length}`);
  };
  for (const key of ["customer_id", "entity_id", "uploader_id"] as const) {
    const value = query.get(key);
    if (!value) continue;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      throw new AppError(400, "검색 식별자를 확인해 주세요.");
    if (key === "customer_id") {
      values.push(value);
      where.push(customerCondition(alias, `$${values.length}`));
    } else
      add(
        key === "uploader_id"
          ? alias === "d"
            ? "uploaded_by"
            : "approved_by"
          : key,
        value,
      );
  }
  const kind = query.get("entity_kind");
  if (kind) {
    if (!Object.hasOwn(catalog, kind))
      throw new AppError(400, "자료 유형을 확인해 주세요.");
    add("entity_kind", kind);
  }
  const classification = query.get("classification");
  if (classification) {
    if (!(classifications as readonly string[]).includes(classification))
      throw new AppError(400, "기밀등급을 확인해 주세요.");
    add("classification", classification);
  }
  const status = query.get("scan_status");
  if (status) {
    if (!["pending", "clean", "infected", "error"].includes(status))
      throw new AppError(400, "검사 상태를 확인해 주세요.");
    // Reports have no scan status; shared search queries only filter documents.
    if (alias === "d") add("scan_status", status);
  }
  const audience = query.get("audience");
  if (audience && alias === "r") {
    if (!["internal", "customer"].includes(audience))
      throw new AppError(400, "보고서 대상을 확인해 주세요.");
    add("audience", audience);
  }
  const from = query.get("from"),
    to = query.get("to");
  if (from) queryDate(from);
  if (to) queryDate(to);
  if (from && to && from > to)
    throw new AppError(400, "날짜 범위를 확인해 주세요.");
  if (from) {
    values.push(from);
    where.push(
      `${alias}.created_at >= ($${values.length}::date::timestamp AT TIME ZONE 'Asia/Seoul')`,
    );
  }
  if (to) {
    values.push(to);
    where.push(
      `${alias}.created_at < (($${values.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')`,
    );
  }
  const text = query.get("q");
  if (text) {
    values.push(`%${text.slice(0, 150)}%`);
    const parameter = `$${values.length}`;
    where.push(
      `${alias}.${alias === "d" ? "name" : "title"} ILIKE ${parameter}`,
    );
  }
}
