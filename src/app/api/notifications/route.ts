import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, assertOrigin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { failure, pagination, parseInput, readOptionalJson } from "@/lib/http";
const markRead = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict(),
]);
export async function GET(request: Request) {
  try {
    const u = await requireUser(),
      q = new URL(request.url).searchParams,
      p = pagination(q, 50),
      state = parseInput(z.enum(["", "unread", "read"]), q.get("read") || ""),
      db = await getDb(),
      where =
        "user_id=$1" +
        (state === "unread"
          ? " AND read_at IS NULL"
          : state === "read"
            ? " AND read_at IS NOT NULL"
            : ""),
      [count] = await db.query(
        "SELECT count(*)::int total FROM notifications WHERE " + where,
        [u.id],
      ),
      [unread] = await db.query(
        "SELECT count(*)::int total FROM notifications WHERE user_id=$1 AND read_at IS NULL",
        [u.id],
      ),
      rows = await db.query(
        `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,
        [u.id, p.limit, p.offset],
      );
    return NextResponse.json({
      rows,
      total: count.total,
      unread_total: unread.total,
      page: p.page,
      limit: p.limit,
    });
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser(),
      body = await readOptionalJson(request),
      b = body === null ? null : parseInput(markRead, body),
      ids = b && "ids" in b ? b.ids : null;
    await (
      await getDb()
    ).query(
      "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL" +
        (ids ? " AND id=ANY($2::text[])" : ""),
      ids ? [u.id, ids] : [u.id],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
