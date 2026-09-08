import { NextResponse } from "next/server";
import { assertOrigin, requireUser } from "@/lib/auth";
import { setInspectionDeleted } from "@/lib/records";
import { AppError } from "@/lib/policy";
import { failure, readJson } from "@/lib/http";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    assertOrigin(request);
    const user = await requireUser(),
      p = await params;
    if (p.kind !== "inspections")
      throw new AppError(405, "이 자료의 복원은 지원하지 않습니다.");
    return NextResponse.json(
      await setInspectionDeleted(user, p.id, await readJson(request), false),
    );
  } catch (e) {
    return failure(e);
  }
}
