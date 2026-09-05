import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { lookups } from "@/lib/records";
import { failure } from "@/lib/http";
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    return NextResponse.json(
      await lookups(new URL(request.url).searchParams, user),
    );
  } catch (e) {
    return failure(e);
  }
}
