import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { lookups } from "@/lib/records";
import { failure } from "@/lib/http";
export async function GET() {
  try {
    await requireUser();
    return NextResponse.json(await lookups());
  } catch (e) {
    return failure(e);
  }
}
