import { NextResponse } from "next/server";
import { requireUser, assertOrigin, audit } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { catalog } from "@/lib/catalog";
import { saveRecord } from "@/lib/records";
import { validateEntity } from "@/lib/validation";
import { AppError, requirePermission, can } from "@/lib/policy";
import { failure, readJson } from "@/lib/http";
import { parseSheet, workbookBytes } from "@/lib/sheets";
const mapping: Record<string, string> = {
  site_id: "사업장 ID",
  name: "자산명",
  asset_tag: "자산 ID",
  product: "제품",
  model: "모델",
  software_version: "소프트웨어 버전",
  protection: "보호 모드",
  status: "확인 상태",
};
export async function GET() {
  try {
    const u = await requireUser();
    requirePermission(u.role, "assets:write");
    const rows = await (
      await getDb()
    ).query(
      "SELECT s.id site_id,s.name,c.name customer_name FROM sites s JOIN customers c ON c.id=s.customer_id WHERE s.status='active' ORDER BY s.name LIMIT 1",
    );
    const data = [
      {
        site_id: rows[0]?.site_id || "사업장 내부 ID를 입력하세요",
        name: "예시 서버",
        asset_tag: "SAMPLE-001",
        product: "Server",
        model: "모델명",
        software_version: "",
        protection: "unknown",
        status: "unknown",
      },
    ];
    return new NextResponse(
      await workbookBytes(data, Object.entries(mapping)),
      {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition":
            "attachment; filename=operix-assets-template.xlsx",
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "assets:write");
    if (Number(request.headers.get("content-length")) > 6 * 1024 * 1024)
      throw new AppError(413, "파일은 5MB 이하로 선택해 주세요.");
    const form = await request.formData(),
      file = form.get("file");
    if (!(file instanceof File))
      throw new AppError(400, "파일을 선택해 주세요.");
    const rows = await parseSheet(file);
    let supplied: Record<string, string> = {};
    if (form.get("mapping")) {
      try {
        supplied = JSON.parse(String(form.get("mapping")));
      } catch {
        throw new AppError(400, "열 매핑 형식을 확인해 주세요.");
      }
    }
    const map = { ...mapping, ...supplied },
      db = await getDb(),
      result: any[] = [],
      seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      try {
        const input: Record<string, any> = {};
        for (const field of catalog.assets.fields) {
          const header = map[field.key] || field.key;
          if (Object.hasOwn(rows[i], header))
            input[field.key] = rows[i][header];
        }
        if (!input.site_id || !input.name || !input.product)
          throw new AppError(400, "사업장 ID·자산명·제품은 필수입니다.");
        const identity = String(
          input.asset_tag || `${input.site_id}:${input.name}`,
        ).toLowerCase();
        if (seen.has(identity))
          throw new AppError(400, "파일 내 중복 자산입니다.");
        seen.add(identity);
        const existing = input.asset_tag
          ? (
              await db.query(
                "SELECT * FROM assets WHERE lower(asset_tag)=lower($1)",
                [input.asset_tag],
              )
            )[0]
          : null;
        if (!input.asset_tag) {
          const same = await db.query(
            "SELECT id FROM assets WHERE site_id=$1 AND name=$2",
            [input.site_id, input.name],
          );
          if (same.length)
            throw new AppError(
              400,
              "같은 사업장·이름의 자산이 있습니다. 자산 ID를 확인해 주세요.",
            );
        }
        const previous: Record<string, any> = {};
        if (existing)
          for (const field of catalog.assets.fields)
            if (
              Object.hasOwn(existing, field.key) &&
              (!field.permission || can(u.role, field.permission))
            )
              previous[field.key] = existing[field.key];
        const data = validateEntity("assets", { ...previous, ...input });
        const [site] = await db.query(
          "SELECT name FROM sites WHERE id=$1 AND status='active'",
          [data.site_id],
        );
        if (!site) throw new AppError(400, "사업장 ID를 확인해 주세요.");
        for (const field of catalog.assets.fields)
          if (field.permission && !can(u.role, field.permission))
            delete data[field.key];
        result.push({
          row: i + 2,
          action: existing ? "update" : "create",
          id: existing?.id,
          version: existing?.version,
          name: data.name,
          site_name: site.name,
          data,
        });
      } catch (e) {
        result.push({
          row: i + 2,
          action: "error",
          name: rows[i][map.name] || "",
          error: e instanceof Error ? e.message : "검증 실패",
        });
      }
    }
    const id = crypto.randomUUID();
    await db.query(
      "INSERT INTO import_batches(id,user_id,payload,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",
      [id, u.id, JSON.stringify(result)],
    );
    return NextResponse.json({
      batch_id: id,
      headers: Object.keys(rows[0] || {}),
      rows: result.map(({ data, ...rest }) => rest),
      valid: result.every((row) => row.action !== "error"),
    });
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "assets:write");
    const b = await readJson(request),
      db = await getDb();
    const result = await db.transaction(async (tx) => {
      const [batch] = await tx.query(
        "SELECT * FROM import_batches WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [b.batch_id, u.id],
      );
      if (!batch) throw new AppError(404, "가져오기 작업을 찾을 수 없습니다.");
      if (batch.committed_at)
        throw new AppError(409, "이미 반영된 작업입니다.");
      if (new Date(batch.expires_at) < new Date())
        throw new AppError(410, "미리보기 유효 시간이 지났습니다.");
      if (batch.payload.some((r: any) => r.action === "error"))
        throw new AppError(400, "오류 행을 수정한 뒤 다시 가져와 주세요.");
      for (const row of batch.payload)
        await saveRecord(
          "assets",
          u,
          { ...row.data, ...(row.version ? { version: row.version } : {}) },
          row.id,
          tx,
        );
      await tx.query(
        "UPDATE import_batches SET committed_at=now() WHERE id=$1",
        [batch.id],
      );
      await audit(tx, u.id, "import", "assets", batch.id, {
        count: batch.payload.length,
      });
      return { count: batch.payload.length };
    });
    return NextResponse.json(result);
  } catch (e) {
    return failure(e);
  }
}
