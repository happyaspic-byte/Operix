import { NextResponse } from "next/server";
import { assertOrigin, requireUser } from "@/lib/auth";
import { failure, readJson } from "@/lib/http";
import { updateVisitPrep, visitPrep } from "@/lib/visit-prep";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return NextResponse.json(
      await visitPrep((await params).id, await requireUser()),
    );
  } catch (e) {
    return failure(e);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertOrigin(request);
    const user = await requireUser();
    return NextResponse.json(
      await updateVisitPrep((await params).id, user, await readJson(request)),
    );
  } catch (e) {
    return failure(e);
  }
}
