import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, assertOrigin } from "@/lib/auth";
import { requirePermission, AppError } from "@/lib/policy";
import { getDb } from "@/lib/db";
import { securityLog } from "@/lib/security";
import {
  readJson,
  parseInput,
  pagination,
  queryDate,
  failure,
} from "@/lib/http";
export async function GET(request: Request) {
  try {
    const u = await requireUser();
    requirePermission(u.role, "audit");
    const q = new URL(request.url).searchParams,
      p = pagination(q),
      values: unknown[] = [],
      where = ["true"];
    for (const [key, column, op] of [
      ["from", "occurred_at::date", ">="],
      ["to", "occurred_at::date", "<="],
      ["user_id", "user_id", "="],
      ["outcome", "outcome", "="],
    ])
      if (q.get(key)) {
        values.push(
          key === "from" || key === "to" ? queryDate(q.get(key)!) : q.get(key),
        );
        where.push(`${column}${op}$${values.length}`);
      }
    const db = await getDb(),
      [count] = await db.query(
        "SELECT count(*)::int total FROM security_logs WHERE " +
          where.join(" AND "),
        values,
      ),
      rows = await db.query(
        `SELECT * FROM security_logs WHERE ${where.join(" AND ")} ORDER BY sequence DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, p.limit, p.offset],
      );
    await securityLog(
      u,
      { action: "review_access_logs", kind: "security_logs" },
      request,
    );
    return NextResponse.json({
      rows,
      total: count.total,
      page: p.page,
      limit: p.limit,
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "audit");
    const b = parseInput(
      z
        .object({
          from: z.string(),
          to: z.string(),
          findings: z.string().trim().min(5).max(2000),
          follow_up: z.string().trim().min(3).max(2000),
        })
        .strict(),
      await readJson(request),
    );
    queryDate(b.from);
    queryDate(b.to);
    if (b.from > b.to) throw new AppError(400, "점검 기간을 확인해 주세요.");
    await (
      await getDb()
    ).query(
      "INSERT INTO security_reviews(id,reviewer_id,from_date,to_date,findings,follow_up) VALUES ($1,$2,$3,$4,$5,$6)",
      [crypto.randomUUID(), u.id, b.from, b.to, b.findings, b.follow_up],
    );
    await securityLog(
      u,
      { action: "record_security_review", kind: "security_reviews" },
      request,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
