import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { assetHistory } from "@/lib/asset-history";
import { failure } from "@/lib/http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    return NextResponse.json(
      await assetHistory(id, user, new URL(request.url).searchParams),
    );
  } catch (error) {
    return failure(error);
  }
}
