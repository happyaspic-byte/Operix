import { NextResponse } from "next/server";
import { AppError } from "./policy";
export function failure(error: unknown) {
  if (error instanceof AppError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  const code = (error as { code?: string })?.code;
  if (code === "23505")
    return NextResponse.json(
      { error: "동일한 식별자 또는 이름이 이미 등록되어 있습니다." },
      { status: 409 },
    );
  if (code === "23503")
    return NextResponse.json(
      { error: "연결된 자료를 확인해 주세요." },
      { status: 400 },
    );
  console.error(
    "operix.request.failed",
    error instanceof Error ? error.message : "unknown error",
  );
  return NextResponse.json(
    { error: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." },
    { status: 500 },
  );
}
export async function readJson(request: Request) {
  const text = await request.text();
  if (text.length > 1024 * 1024)
    throw new AppError(413, "입력 데이터가 너무 큽니다.");
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "올바른 JSON 형식이 아닙니다.");
  }
}
