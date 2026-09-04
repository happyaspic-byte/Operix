import { NextResponse } from "next/server";
import { requireUser, assertOrigin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { failure } from "@/lib/http";
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(
      await (
        await getDb()
      ).query(
        "SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
        [user.id],
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(request: Request) {
  try {
    assertOrigin(request);
    const user = await requireUser();
    await (
      await getDb()
    ).query(
      "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL",
      [user.id],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
