import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { overview } from "@/lib/overview";
import { failure } from "@/lib/http";
export async function GET() {
  try {
    return NextResponse.json(await overview(await requireUser()));
  } catch (e) {
    return failure(e);
  }
}
