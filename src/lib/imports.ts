import { z } from "zod";
import { getDb, type Row } from "./db";
import { catalog } from "./catalog";
import { validateEntity } from "./validation";
import { getRecord, saveRecord } from "./records";
import { AppError, requirePermission, can } from "./policy";
import { parseInput } from "./http";
import { parseSheet } from "./sheets";
import { scanBytes } from "./file-scanner";
import { audit, type User } from "./auth";
import { lockBusiness } from "./transactions";
export const importKinds = [
  "customers",
  "sites",
  "assets",
  "contracts",
] as const;
export type ImportKind = (typeof importKinds)[number];
export function importMapping(kind: ImportKind): Record<string, string> {
  const base = Object.fromEntries(
    catalog[kind].fields
      .filter((f) => !["assets", "checklist"].includes(f.type || ""))
      .map((f) => [f.key, f.label]),
  );
  if (kind === "assets")
    Object.assign(base, {
      site_id: "사업장 ID",
      name: "자산명",
      asset_tag: "자산 ID",
      product: "제품",
      model: "모델",
      software_version: "소프트웨어 버전",
      protection: "보호 모드",
      status: "확인 상태",
    });
  if (kind !== "customers") base.customer_name = "고객사명";
  if (kind === "assets") base.site_name = "사업장명";
  if (kind === "contracts") base.asset_tags = "연결 자산 ID (쉼표 구분)";
  return base;
}
export async function previewImport(
  user: User,
  kind: ImportKind,
  file: File,
  supplied: unknown = {},
  suppliedSites: unknown = {},
) {
  requirePermission(user.role, catalog[kind].permission);
  const explicitMapping = parseInput(
    z.record(z.string().max(100), z.string().max(100)),
    supplied,
  );
  const siteMapping = parseInput(
    z.record(z.string().max(1000), z.string().uuid()),
    suppliedSites,
  );
  const mapping = { ...importMapping(kind), ...explicitMapping };
  const scanned = await scanBytes(Buffer.from(await file.arrayBuffer()));
  if (scanned.status !== "clean")
    throw new AppError(
      423,
      "검사가 완료되지 않았거나 위험한 가져오기 파일입니다.",
    );
  const rows = await parseSheet(file),
    db = await getDb(),
    result: Row[] = [],
    seen = new Set<string>(),
    seenSerials = new Set<string>();
  const headers = Object.keys(rows[0] || {});
  const alm =
    kind === "assets" &&
    [
      "display_name",
      "serial_number",
      "u_asset_type",
      "account",
      "location.u_city_state_county_country_combined",
    ].every((header) => headers.includes(header));
  if (alm) {
    const aliases: Record<string, string> = {
      name: "display_name",
      serial: "serial_number",
      product: "u_asset_type",
      customer_name: "account",
      site_name: "location.u_city_state_county_country_combined",
    };
    for (const [key, header] of Object.entries(aliases))
      if (
        !Object.hasOwn(explicitMapping, key) &&
        !headers.includes(mapping[key])
      )
        mapping[key] = header;
  }
  const siteGroups = alm
    ? [
        ...new Map(
          rows.map((row) => {
            const customer = row.account || "",
              location =
                row["location.u_city_state_county_country_combined"] || "";
            const key = JSON.stringify([customer, location]);
            return [key, { key, customer, location }];
          }),
        ).values(),
      ]
    : [];
  if (
    Object.keys(siteMapping).some(
      (key) => !siteGroups.some((group) => group.key === key),
    )
  )
    throw new AppError(400, "파일에 없는 고객사·위치의 사업장 연결입니다.");
  const availableSites = alm
    ? await db.query(
        "SELECT s.id,s.name,c.name AS customer_name FROM sites s JOIN customers c ON c.id=s.customer_id WHERE s.status='active' AND c.status='active' ORDER BY c.name,s.name",
      )
    : [];
  async function one(sql: string, values: unknown[], label: string) {
    const rows = await db.query(sql, values);
    if (rows.length !== 1)
      throw new AppError(
        400,
        label +
          ": 일치하는 자료가 없거나 여러 개입니다. 내부 ID로 구분해 주세요.",
      );
    return rows[0];
  }
  for (let i = 0; i < rows.length; i++) {
    try {
      const input: Row = {},
        warnings: string[] = [];
      const source = rows[i];
      const groupKey = alm
        ? JSON.stringify([
            source.account || "",
            source["location.u_city_state_county_country_combined"] || "",
          ])
        : "";
      for (const field of catalog[kind].fields) {
        const header = mapping[field.key] || field.key;
        if (Object.hasOwn(rows[i], header)) {
          const value = rows[i][header];
          // Empty template enum cells use defaults for new rows and preserve
          // existing selections. An empty restricted column is not a write.
          if (value === "" && (field.type === "select" || field.permission))
            continue;
          input[field.key] = value;
        }
      }
      const fallbackTag = alm && !input.asset_tag;
      if (alm) {
        if (!input.asset_tag && !input.serial)
          throw new AppError(
            400,
            "ALM 시리얼 또는 명시적 자산 ID가 필요합니다.",
          );
        if (input.serial) {
          const serialKey = String(input.serial).toLowerCase();
          if (seenSerials.has(serialKey))
            throw new AppError(400, "파일 내 시리얼이 중복됩니다.");
          seenSerials.add(serialKey);
        }
      }
      if (fallbackTag) {
        if (!input.serial)
          throw new AppError(
            400,
            "ALM 시리얼 또는 명시적 자산 ID가 필요합니다.",
          );
        input.asset_tag = input.serial;
      }
      if (alm && mapping.product === "u_asset_type") {
        const products: Record<string, string> = {
          "everRun Enterprise": "everRun",
          ztCEdge: "ztC Edge",
          windows: "Server",
        };
        const converted = products[input.product];
        if (converted) {
          warnings.push(
            `원본 자산 유형 ${input.product} → 제품 ${converted} (원본은 메모에 보존)`,
          );
          input.product = converted;
        }
      }
      if (alm && siteMapping[groupKey]) {
        if (!availableSites.some((site) => site.id === siteMapping[groupKey]))
          throw new AppError(
            400,
            "활성 고객사에 속한 활성 사업장을 선택해 주세요.",
          );
        input.site_id = siteMapping[groupKey];
        warnings.push(
          "원본 고객사·위치를 선택한 사업장에 연결합니다. 원본은 메모에 보존됩니다.",
        );
      }
      const customerName = rows[i][mapping.customer_name],
        siteName = rows[i][mapping.site_name];
      if (
        kind !== "customers" &&
        kind !== "assets" &&
        !input.customer_id &&
        customerName
      )
        input.customer_id = (
          await one(
            "SELECT id FROM customers WHERE lower(name)=lower($1) AND status='active'",
            [customerName],
            "고객사명",
          )
        ).id;
      if (kind === "assets" && !input.site_id && customerName && siteName)
        input.site_id = (
          await one(
            "SELECT s.id FROM sites s JOIN customers c ON c.id=s.customer_id WHERE lower(c.name)=lower($1) AND lower(s.name)=lower($2) AND s.status='active' AND c.status='active'",
            [customerName, siteName],
            "고객사·사업장명",
          )
        ).id;
      if (!input.name) throw new AppError(400, "이름은 필수입니다.");
      if (kind === "assets" && (!input.site_id || !input.product))
        throw new AppError(
          400,
          "사업장 ID 또는 고객사·사업장명과 제품을 입력해 주세요.",
        );
      if (["sites", "contracts"].includes(kind) && !input.customer_id)
        throw new AppError(400, "고객사 ID 또는 고객사명을 입력해 주세요.");
      const identity =
        kind === "customers"
          ? input.name
          : kind === "assets"
            ? input.asset_tag || input.site_id + ":" + input.name
            : input.customer_id +
              ":" +
              input.name +
              (kind === "contracts" ? ":" + input.kind : "");
      const key = String(identity).toLowerCase();
      if (seen.has(key))
        throw new AppError(400, "파일 내 식별 기준이 중복됩니다.");
      seen.add(key);
      let matches: Row[] = [];
      if (kind === "assets")
        matches = input.asset_tag
          ? await db.query(
              "SELECT * FROM assets WHERE lower(asset_tag)=lower($1)",
              [input.asset_tag],
            )
          : await db.query(
              "SELECT * FROM assets WHERE site_id=$1 AND name=$2",
              [input.site_id, input.name],
            );
      else if (kind === "customers")
        matches = await db.query(
          "SELECT * FROM customers WHERE lower(name)=lower($1)",
          [input.name],
        );
      else if (kind === "sites")
        matches = await db.query(
          "SELECT * FROM sites WHERE customer_id=$1 AND lower(name)=lower($2)",
          [input.customer_id, input.name],
        );
      else
        matches = await db.query(
          "SELECT * FROM contracts WHERE customer_id=$1 AND lower(name)=lower($2) AND kind=$3",
          [input.customer_id, input.name, input.kind],
        );
      if (alm && input.serial) {
        const serialMatches = await db.query(
          "SELECT * FROM assets WHERE lower(serial)=lower($1)",
          [input.serial],
        );
        if (
          serialMatches.length > 1 ||
          (matches.length &&
            serialMatches.some((row) => row.id !== matches[0].id))
        )
          throw new AppError(
            400,
            "기존 시리얼이 중복되거나 자산 ID와 충돌합니다. 개별 자료를 확인해 주세요.",
          );
        if (!fallbackTag && serialMatches.length && !matches.length)
          throw new AppError(
            400,
            "기존 시리얼의 자산 ID와 명시적 자산 ID가 다릅니다.",
          );
        if (fallbackTag && serialMatches.length) {
          if (matches.length && matches[0].id !== serialMatches[0].id)
            throw new AppError(
              400,
              "시리얼과 자산 ID가 서로 다른 자료를 가리킵니다.",
            );
          matches = serialMatches;
          input.asset_tag = matches[0].asset_tag || input.serial;
        }

        if (
          matches.length &&
          matches[0].serial &&
          String(matches[0].serial).toLowerCase() !==
            String(input.serial).toLowerCase()
        )
          throw new AppError(
            400,
            "기존 자산 ID의 시리얼과 원본 시리얼이 다릅니다.",
          );
      }
      if (alm && matches.length && matches[0].site_id !== input.site_id)
        throw new AppError(
          400,
          "기존 자산의 사업장은 ALM 가져오기로 변경할 수 없습니다.",
        );
      if (alm && matches.length && !input.serial) delete input.serial;
      if (matches.length > 1)
        throw new AppError(
          400,
          "일치하는 기존 자료가 여러 개입니다. 개별 자료를 확인해 주세요.",
        );
      if (kind === "assets" && !input.asset_tag && matches.length)
        throw new AppError(
          400,
          "같은 사업장·이름의 자산이 있습니다. 자산 ID로 구분해 주세요.",
        );
      const existing = matches[0]
        ? await getRecord(kind, matches[0].id, user)
        : null;
      if (existing?.privacy_erased_at)
        throw new AppError(410, "파기된 자료를 가져오기로 복구할 수 없습니다.");
      const previous: Row = {};
      if (existing)
        for (const f of catalog[kind].fields)
          if (
            (!f.permission || can(user.role, f.permission)) &&
            f.key in existing
          )
            previous[f.key] =
              existing[f.key] === null &&
              !["relation", "date", "number"].includes(f.type || "")
                ? ""
                : existing[f.key];
      if (kind === "contracts" && rows[i][mapping.asset_tags]) {
        const tags = rows[i][mapping.asset_tags]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          ids = [];
        for (const tag of tags)
          ids.push(
            (
              await one(
                "SELECT id FROM assets WHERE lower(asset_tag)=lower($1)",
                [tag],
                "연결 자산 ID",
              )
            ).id,
          );
        input.asset_ids = ids;
      }
      if (alm) {
        if (!existing && !Object.hasOwn(input, "status"))
          input.status = "unknown";
        const labels: Record<string, string> = {
          u_system_name: "ALM 시스템명",
          account: "ALM 원본 고객사",
          "location.u_city_state_county_country_combined": "ALM 원본 위치",
          u_asset_type: "ALM 원본 자산 유형",
          u_entitlement: "ALM 지원 권한",
          u_service_expiration: "ALM 서비스 만료일",
        };
        const notes = String(input.notes ?? previous.notes ?? "").split("\n");
        for (const [header, label] of Object.entries(labels)) {
          if (!source[header]) continue;
          const value = source[header]
            .replaceAll("\\", "\\\\")
            .replaceAll("\r", "\\r")
            .replaceAll("\n", "\\n");
          const line = `${label}: ${value}`;
          if (!notes.includes(line)) notes.push(line);
        }
        input.notes = notes.filter(Boolean).join("\n");
      }
      const data = validateEntity(kind, { ...previous, ...input });
      for (const f of catalog[kind].fields)
        if (f.permission && !can(user.role, f.permission)) {
          if (Object.hasOwn(input, f.key))
            throw new AppError(403, f.label + " 변경 권한이 없습니다.");
          delete data[f.key];
        }
      const changes = Object.keys(data)
        .filter(
          (k) =>
            JSON.stringify(previous[k] ?? "") !== JSON.stringify(data[k] ?? ""),
        )
        .map((k) => ({
          field: k,
          label: catalog[kind].fields.find((f) => f.key === k)?.label || k,
          before: previous[k] ?? "",
          after: data[k],
        }));
      result.push({
        row: i + 2,
        action: existing ? "update" : "create",
        id: existing?.id,
        version: existing?.version,
        name: data.name,
        warnings,
        alm_identity: alm,
        data,
        changes,
      });
    } catch (e) {
      result.push({
        row: i + 2,
        action: "error",
        name: rows[i][mapping.name] || "",
        error:
          e instanceof AppError
            ? e.message
            : "행을 처리하지 못했습니다. 형식을 확인해 주세요.",
      });
    }
  }
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO import_batches(id,user_id,payload,expires_at,entity_kind) VALUES ($1,$2,$3,now()+interval '1 hour',$4)",
    [id, user.id, JSON.stringify(result), kind],
  );
  return {
    batch_id: id,
    headers: Object.keys(rows[0] || {}),
    mapping,
    site_groups: siteGroups,
    sites: availableSites,
    rows: result.map(
      ({ data: _data, alm_identity: _identity, ...rest }) => rest,
    ),
    valid: result.every((r) => r.action !== "error"),
  };
}
export async function commitImport(user: User, id: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockBusiness(tx);
    const [batch] = await tx.query(
      "SELECT * FROM import_batches WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [id, user.id],
    );
    if (!batch) throw new AppError(404, "가져오기 작업을 찾을 수 없습니다.");
    requirePermission(user.role, catalog[batch.entity_kind].permission);
    if (batch.committed_at) throw new AppError(409, "이미 반영된 작업입니다.");
    if (Date.parse(batch.expires_at) < Date.now())
      throw new AppError(410, "미리보기 유효 시간이 지났습니다.");
    if (
      !batch.payload.length ||
      batch.payload.some((r: Row) => r.action === "error")
    )
      throw new AppError(400, "오류를 수정하고 다시 검증해 주세요.");
    for (const row of batch.payload) {
      if (row.alm_identity) {
        const matches = await tx.query(
          "SELECT id,site_id FROM assets WHERE lower(asset_tag)=lower($1) OR ($2<>'' AND lower(serial)=lower($2))",
          [row.data.asset_tag, row.data.serial || ""],
        );
        if (
          matches.some(
            (match) =>
              match.id !== row.id || match.site_id !== row.data.site_id,
          )
        )
          throw new AppError(
            409,
            "ALM 식별 정보가 변경됐거나 시리얼이 중복됩니다. 다시 검증해 주세요.",
          );
      }
      await saveRecord(
        batch.entity_kind,
        user,
        { ...row.data, ...(row.version ? { version: row.version } : {}) },
        row.id,
        tx,
      );
    }
    const summary = {
      count: batch.payload.length,
      created: batch.payload.filter((r: Row) => r.action === "create").length,
      updated: batch.payload.filter((r: Row) => r.action === "update").length,
    };
    await tx.query(
      "UPDATE import_batches SET committed_at=now(),payload='[]',summary=$2 WHERE id=$1",
      [batch.id, JSON.stringify(summary)],
    );
    await audit(tx, user.id, "import", batch.entity_kind, batch.id, summary);
    return summary;
  });
}
