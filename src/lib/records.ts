import { getDb, type Database, type Row } from "./db";
import { catalog } from "./catalog";
import { audit, type User } from "./auth";
import { AppError, can, redact, requirePermission } from "./policy";
import { validateEntity } from "./validation";
import { pagination, queryDate } from "./http";
import { workflowFields } from "./workflow";
import { lockBusiness } from "./transactions";
const customerJoin =
  " JOIN sites s ON s.id=a.site_id JOIN customers c ON c.id=s.customer_id";
export function selection(kind: string) {
  switch (kind) {
    case "customer_contacts":
      return "SELECT e.*,c.name customer_name,s.name site_name FROM customer_contacts e JOIN customers c ON c.id=e.customer_id LEFT JOIN sites s ON s.id=e.site_id";
    case "sites":
      return "SELECT e.*,c.name customer_name FROM sites e JOIN customers c ON c.id=e.customer_id";
    case "assets":
      return "SELECT e.*,s.name site_name,c.name customer_name,c.id customer_id,u.name owner_name FROM assets e JOIN sites s ON s.id=e.site_id JOIN customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=e.owner_id";
    case "contracts":
      return "SELECT e.*,c.name customer_name,u.name owner_name,COALESCE((SELECT jsonb_agg(asset_id) FROM contract_assets WHERE contract_id=e.id),'[]') asset_ids FROM contracts e JOIN customers c ON c.id=e.customer_id LEFT JOIN users u ON u.id=e.owner_id";
    case "tickets":
      return "SELECT e.*,c.name customer_name,u.name assignee_name,COALESCE((SELECT jsonb_agg(asset_id) FROM ticket_assets WHERE ticket_id=e.id),'[]') asset_ids FROM tickets e JOIN customers c ON c.id=e.customer_id LEFT JOIN users u ON u.id=e.assignee_id";
    case "maintenance_plans":
    case "inspections":
      return `SELECT e.*,a.name asset_name,c.name customer_name,u.name assignee_name FROM ${kind} e JOIN assets a ON a.id=e.asset_id${customerJoin} LEFT JOIN users u ON u.id=e.assignee_id`;
    default:
      return `SELECT e.* FROM ${kind} e`;
  }
}
export async function listRecords(
  kind: string,
  user: User,
  query: URLSearchParams,
  database?: Database,
) {
  if (!Object.hasOwn(catalog, kind))
    throw new AppError(404, "자료 유형을 찾을 수 없습니다.");
  const db = database || (await getDb()),
    params: any[] = [],
    where: string[] = [];
  const q = (query.get("q") || "").slice(0, 150);
  if (q) {
    params.push(`%${q}%`);
    where.push(
      kind === "assets"
        ? `(e.name ILIKE $${params.length} OR e.asset_tag ILIKE $${params.length} OR c.name ILIKE $${params.length})`
        : `e.name ILIKE $${params.length}`,
    );
  }
  for (const key of [
    "asset_id",
    "customer_id",
    "site_id",
    "status",
    "owner_id",
    "assignee_id",
    "renewal",
    "severity",
  ])
    if (query.get(key) && catalog[kind].fields.some((f) => f.key === key)) {
      params.push(query.get(key));
      where.push(`e.${key}=$${params.length}`);
    }
  if (query.get("mine") === "1") {
    const key = catalog[kind].fields.find((f) =>
      ["assignee_id", "owner_id"].includes(f.key),
    )?.key;
    if (key) {
      params.push(user.id);
      where.push(`e.${key}=$${params.length}`);
    }
  }
  const dateKey = query.get("date_field") || "created_at";
  if (query.get("from") || query.get("to")) {
    if (
      dateKey !== "created_at" &&
      !catalog[kind].fields.some((f) => f.key === dateKey && f.type === "date")
    )
      throw new AppError(400, "날짜 필터를 확인해 주세요.");
    for (const [k, op] of [
      ["from", ">="],
      ["to", "<="],
    ])
      if (query.get(k)) {
        params.push(queryDate(query.get(k)!));
        where.push(`e.${dateKey}::date${op}$${params.length}::date`);
      }
  }
  if (query.get("expiry") && kind === "contracts") {
    const choice = query.get("expiry")!;
    if (choice === "overdue")
      where.push("e.term='dated' AND e.end_date<CURRENT_DATE");
    else if (choice === "30")
      where.push(
        "e.term='dated' AND e.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30",
      );
    else if (["unknown", "perpetual"].includes(choice)) {
      params.push(choice);
      where.push(`e.term=$${params.length}`);
    } else throw new AppError(400, "만료 필터를 확인해 주세요.");
  }
  const filter = where.length ? " WHERE " + where.join(" AND ") : "";
  const count = await db.query(
    `SELECT count(*)::int total FROM (${selection(kind)}${filter}) data`,
    params,
  );
  const { limit, page, offset } = pagination(query);
  const sort = query.get("sort");
  const allowed = [
    "name",
    "created_at",
    ...catalog[kind].fields
      .filter((f) => ["date", "number"].includes(f.type || ""))
      .map((f) => f.key),
  ];
  const order = allowed.includes(sort || "") ? sort : "created_at",
    direction = query.get("direction") === "asc" ? "ASC" : "DESC";
  const rows = await db.query(
    `${selection(kind)}${filter} ORDER BY e.${order} ${direction},e.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return {
    rows: rows.map((r) => redact(r, user.role)),
    total: count[0].total,
    page,
    limit,
  };
}
export async function getRecord(
  kind: string,
  id: string,
  user: User,
  db?: Database,
) {
  if (!Object.hasOwn(catalog, kind))
    throw new AppError(404, "자료 유형을 찾을 수 없습니다.");
  const [record] = await (db || (await getDb())).query(
    `${selection(kind)} WHERE e.id=$1`,
    [id],
  );
  if (!record) throw new AppError(404, "자료를 찾을 수 없습니다.");
  return redact(record, user.role);
}
async function validateRelations(
  tx: Database,
  kind: string,
  data: Row,
  previous?: Row,
) {
  for (const f of catalog[kind].fields.filter((f) => f.type === "relation")) {
    if (!data[f.key]) continue;
    const [ref] = await tx.query(`SELECT * FROM ${f.entity} WHERE id=$1`, [
      data[f.key],
    ]);
    if (
      !ref ||
      ((ref.active === false || ref.status === "archived") &&
        previous?.[f.key] !== data[f.key])
    )
      throw new AppError(400, `${f.label}: 사용 가능한 자료를 선택해 주세요.`);
  }
  if (data.asset_ids)
    for (const assetId of data.asset_ids) {
      const [a] = await tx.query(
        "SELECT c.id,a.status asset_status,s.status site_status,c.status customer_status FROM assets a" +
          customerJoin +
          " WHERE a.id=$1",
        [assetId],
      );
      if (!a || a.id !== data.customer_id)
        throw new AppError(400, "선택한 자산이 해당 고객사의 자산이 아닙니다.");
      if (
        [a.asset_status, a.site_status, a.customer_status].includes("archived")
      ) {
        const join = kind === "contracts" ? "contract_assets" : "ticket_assets",
          key = kind === "contracts" ? "contract_id" : "ticket_id";
        const retained = previous
          ? await tx.query(
              `SELECT asset_id FROM ${join} WHERE ${key}=$1 AND asset_id=$2`,
              [previous.id, assetId],
            )
          : [];
        if (!retained.length)
          throw new AppError(400, "보관된 자산을 새로 연결할 수 없습니다.");
      }
    }
}
export async function saveRecord(
  kind: string,
  user: User,
  input: Row,
  id?: string,
  existingTx?: Database,
) {
  const config = catalog[kind];
  if (!Object.hasOwn(catalog, kind))
    throw new AppError(404, "자료 유형을 찾을 수 없습니다.");
  requirePermission(user.role, config.permission);
  const { version, ...raw } = input;
  if (id && (!Number.isInteger(version) || version < 1))
    throw new AppError(400, "수정 버전이 필요합니다.");
  for (const f of config.fields)
    if (
      f.permission &&
      !can(user.role, f.permission) &&
      Object.hasOwn(raw, f.key)
    )
      throw new AppError(403, `${f.label} 변경 권한이 없습니다.`);
  const data = validateEntity(kind, raw);
  for (const f of config.fields)
    if (f.permission && !can(user.role, f.permission)) delete data[f.key];
  const mutate = async (tx: Database) => {
    await lockBusiness(tx);
    let previous: Row | undefined;
    if (id) {
      [previous] = await tx.query(
        `SELECT * FROM ${kind} WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!previous) throw new AppError(404, "자료를 찾을 수 없습니다.");
      if (previous.version !== version)
        throw new AppError(
          409,
          "다른 사용자가 수정했습니다. 새로고침 후 다시 확인해 주세요.",
        );
    }
    if (
      user.role === "engineer" &&
      ["tickets", "inspections", "maintenance_plans"].includes(kind)
    ) {
      if (previous?.assignee_id && previous.assignee_id !== user.id)
        throw new AppError(403, "담당 작업만 수정할 수 있습니다.");
      if (data.assignee_id && data.assignee_id !== user.id)
        throw new AppError(403, "다른 직원에게 업무를 배정할 권한이 없습니다.");
      data.assignee_id = user.id;
    }
    await validateRelations(tx, kind, data, previous);
    if (previous?.privacy_erased_at)
      throw new AppError(410, "파기된 자료는 다시 수정할 수 없습니다.");
    if (kind === "assets" && previous && previous.site_id !== data.site_id) {
      const [old] = await tx.query(
        "SELECT customer_id FROM sites WHERE id=$1",
        [previous.site_id],
      );
      const [target] = await tx.query(
        "SELECT customer_id FROM sites WHERE id=$1",
        [data.site_id],
      );
      if (old.customer_id !== target.customer_id) {
        const links = await tx.query(
          "SELECT asset_id FROM contract_assets WHERE asset_id=$1 UNION SELECT asset_id FROM ticket_assets WHERE asset_id=$1",
          [id],
        );
        if (links.length)
          throw new AppError(
            409,
            "계약·작업에 연결된 자산은 고객사를 변경할 수 없습니다.",
          );
      }
    }
    if (
      kind === "sites" &&
      previous &&
      previous.customer_id !== data.customer_id
    ) {
      const children = await tx.query(
        "SELECT id FROM assets WHERE site_id=$1 LIMIT 1",
        [id],
      );
      if (children.length)
        throw new AppError(
          409,
          "자산이 있는 사업장의 고객사는 변경할 수 없습니다.",
        );
    }
    if (
      kind === "maintenance_plans" &&
      previous &&
      (previous.start_date?.toString().slice(0, 10) !== data.start_date ||
        previous.interval_months !== data.interval_months)
    )
      throw new AppError(
        409,
        "기존 반복 계획의 시작일·주기는 보존됩니다. 기존 계획을 보관하고 새 계획을 등록해 주세요.",
      );
    if (
      kind === "maintenance_plans" &&
      previous &&
      previous.asset_id !== data.asset_id
    ) {
      const generated = await tx.query(
        "SELECT id FROM inspections WHERE plan_id=$1 LIMIT 1",
        [id],
      );
      if (generated.length)
        throw new AppError(
          409,
          "생성된 회차가 있는 계획의 자산은 변경할 수 없습니다. 기존 계획을 보관하고 새 계획을 만드세요.",
        );
    }
    if (
      !previous ||
      (kind === "assets" && previous.site_id !== data.site_id) ||
      (kind === "sites" && previous.customer_id !== data.customer_id) ||
      (["inspections", "maintenance_plans", "components", "vms"].includes(
        kind,
      ) &&
        previous.asset_id !== data.asset_id)
    ) {
      const relation = [
        "inspections",
        "maintenance_plans",
        "components",
        "vms",
      ].includes(kind)
        ? await tx.query(
            "SELECT a.status asset_status,s.status site_status,c.status customer_status FROM assets a JOIN sites s ON s.id=a.site_id JOIN customers c ON c.id=s.customer_id WHERE a.id=$1",
            [data.asset_id],
          )
        : kind === "assets"
          ? await tx.query(
              "SELECT s.status site_status,c.status customer_status FROM sites s JOIN customers c ON c.id=s.customer_id WHERE s.id=$1",
              [data.site_id],
            )
          : [];
      if (relation.some((r) => Object.values(r).includes("archived")))
        throw new AppError(
          400,
          "보관된 고객·사업장·자산에 신규 자료를 연결할 수 없습니다.",
        );
    }
    if (kind === "inspections") {
      if (previous?.plan_id && previous.asset_id !== data.asset_id)
        throw new AppError(
          409,
          "반복 계획에서 생성된 회차의 자산은 변경할 수 없습니다.",
        );
      if (
        previous?.status === "completed" &&
        data.status !== "completed" &&
        !can(user.role, "reports:approve")
      )
        throw new AppError(
          403,
          "완료된 점검의 재개는 업무 관리자만 할 수 있습니다.",
        );
      data.completed_at =
        data.status === "completed"
          ? previous?.completed_at || new Date()
          : null;
    }
    if (
      kind === "tickets" &&
      previous?.status === "closed" &&
      data.status !== "closed" &&
      !can(user.role, "reports:approve")
    )
      throw new AppError(
        403,
        "종결된 작업의 재개는 업무 관리자만 할 수 있습니다.",
      );
    await workflowFields(tx, kind, data, previous);
    const assetIds = data.asset_ids;
    delete data.asset_ids;
    const keys = Object.keys(data),
      values = keys.map((k) =>
        Array.isArray(data[k]) ? JSON.stringify(data[k]) : data[k],
      );
    const recordId = id || crypto.randomUUID();
    if (id)
      await tx.query(
        `UPDATE ${kind} SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(",")},version=version+1,updated_at=now() WHERE id=$${keys.length + 1}`,
        [...values, id],
      );
    else
      await tx.query(
        `INSERT INTO ${kind}(id,${keys.join(",")}) VALUES ($1,${keys.map((_, i) => `$${i + 2}`).join(",")})`,
        [recordId, ...values],
      );
    if (
      ["tickets", "inspections"].includes(kind) &&
      previous?.status !== data.status
    )
      await tx.query(
        "INSERT INTO work_status_history(id,entity_kind,entity_id,from_status,to_status,changed_by) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          crypto.randomUUID(),
          kind,
          recordId,
          previous?.status || null,
          data.status,
          user.id,
        ],
      );
    if (assetIds) {
      const join = kind === "contracts" ? "contract_assets" : "ticket_assets",
        key = kind === "contracts" ? "contract_id" : "ticket_id";
      await tx.query(`DELETE FROM ${join} WHERE ${key}=$1`, [recordId]);
      for (const assetId of new Set(assetIds))
        await tx.query(`INSERT INTO ${join}(${key},asset_id) VALUES ($1,$2)`, [
          recordId,
          assetId,
        ]);
    }
    if (kind === "contracts" && id && previous?.end_date !== data.end_date)
      await tx.query(
        "DELETE FROM notifications WHERE source_kind='contracts' AND source_id=$1",
        [id],
      );
    if (kind === "maintenance_plans" && data.status === "archived")
      await tx.query(
        "UPDATE inspections SET status='cancelled',version=version+1,updated_at=now() WHERE plan_id=$1 AND status='scheduled'",
        [recordId],
      );
    if (
      data.status === "archived" &&
      ["customers", "sites", "assets"].includes(kind)
    ) {
      const assetScope =
        kind === "assets"
          ? "SELECT id FROM assets WHERE id=$1"
          : kind === "sites"
            ? "SELECT id FROM assets WHERE site_id=$1"
            : "SELECT a.id FROM assets a JOIN sites s ON s.id=a.site_id WHERE s.customer_id=$1";
      await tx.query(
        `UPDATE maintenance_plans SET status='archived',version=version+1,updated_at=now() WHERE asset_id IN (${assetScope}) AND status='active'`,
        [recordId],
      );
      await tx.query(
        `UPDATE inspections SET status='cancelled',follow_up=concat_ws(E'\n',nullif(follow_up,''),'상위 자료 보관으로 예정 회차 취소'),version=version+1,updated_at=now() WHERE asset_id IN (${assetScope}) AND status='scheduled'`,
        [recordId],
      );
    }
    if (["contracts", "inspections", "maintenance_plans"].includes(kind))
      await tx.query(
        "DELETE FROM notifications WHERE source_kind=$1 AND source_id=$2",
        [kind, recordId],
      );
    await audit(tx, user.id, id ? "update" : "create", kind, recordId, {
      fields: keys,
      version_before: previous?.version ?? null,
      version_after: previous ? previous.version + 1 : 1,
    });
    return getRecord(kind, recordId, user, tx);
  };
  return existingTx ? mutate(existingTx) : (await getDb()).transaction(mutate);
}
export async function lookups(query = new URLSearchParams(), user?: User) {
  const db = await getDb(),
    q = (query.get("q") || "").slice(0, 100),
    currentKind = query.get("current_kind"),
    currentId = query.get("current_id");
  const selected: Record<string, string[]> = {
    customers: [],
    sites: [],
    assets: [],
    users: [],
    contracts: [],
  };
  if (user && currentKind && currentId) {
    const row = await getRecord(currentKind, currentId, user);
    for (const f of catalog[currentKind].fields) {
      if (f.type === "relation" && row[f.key])
        selected[f.entity!]?.push(row[f.key]);
      if (f.type === "assets") selected.assets.push(...(row.asset_ids || []));
    }
  }
  const queries: Record<string, string> = {
    customers:
      "SELECT id,name,status FROM customers WHERE privacy_erased_at IS NULL AND ((status='active' AND name ILIKE $1) OR id=ANY($2::text[]))",
    sites:
      "SELECT s.id,s.name,s.customer_id,c.name customer_name,CASE WHEN s.status='archived' OR c.status='archived' THEN 'archived' ELSE 'active' END status FROM sites s JOIN customers c ON c.id=s.customer_id WHERE (s.status='active' AND c.status='active' AND (s.name ILIKE $1 OR c.name ILIKE $1)) OR s.id=ANY($2::text[])",
    assets:
      "SELECT a.id,a.name,a.asset_tag,a.site_id,s.customer_id,CASE WHEN a.status='archived' OR s.status='archived' OR c.status='archived' THEN 'archived' ELSE a.status END status FROM assets a JOIN sites s ON s.id=a.site_id JOIN customers c ON c.id=s.customer_id WHERE (a.status<>'archived' AND s.status='active' AND c.status='active' AND (a.name ILIKE $1 OR a.asset_tag ILIKE $1 OR c.name ILIKE $1)) OR a.id=ANY($2::text[])",
    contracts:
      "SELECT c.id,c.name,c.customer_id,c.status FROM contracts c WHERE c.privacy_erased_at IS NULL AND ((c.status='active' AND c.name ILIKE $1) OR c.id=ANY($2::text[]))",
    users:
      "SELECT id,name,role,CASE WHEN active THEN 'active' ELSE 'archived' END status FROM users WHERE privacy_erased_at IS NULL AND ((active=true AND name ILIKE $1) OR id=ANY($2::text[]))",
  };
  const result: Record<string, Row[]> = {};
  for (const [key, sql] of Object.entries(queries)) {
    if (query.get("entity") && query.get("entity") !== key) continue;
    result[key] = await db.query(
      `SELECT * FROM (${sql}) candidates ORDER BY (id=ANY($2::text[])) DESC,name,id LIMIT 100`,
      ["%" + q + "%", selected[key]],
    );
  }
  return result;
}
