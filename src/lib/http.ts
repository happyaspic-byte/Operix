import { NextResponse } from "next/server";
import { AppError } from "./policy";
import { z } from "zod";
export function failure(error: unknown) {
  const requestId = crypto.randomUUID();
  if (error instanceof AppError)
    return NextResponse.json(
      { error: error.message, request_id: requestId },
      { status: error.status },
    );
  const code = (error as { code?: string })?.code;
  if (code === "23505")
    return NextResponse.json(
      {
        error: "동일한 식별자 또는 이름이 이미 등록되어 있습니다.",
        request_id: requestId,
      },
      { status: 409 },
    );
  if (code === "23503")
    return NextResponse.json(
      { error: "연결된 자료를 확인해 주세요.", request_id: requestId },
      { status: 400 },
    );
  console.error(
    JSON.stringify({
      event: "operix.request.failed",
      request_id: requestId,
      code: code || "internal_error",
    }),
  );
  return NextResponse.json(
    {
      error: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      request_id: requestId,
    },
    { status: 500 },
  );
}
export async function readLimited(
  request: Request,
  maximum: number,
  timeoutMs = 15000,
): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
    throw new AppError(413, "입력 데이터가 너무 큽니다.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new AppError(408, "요청 본문 전송 시간이 초과되었습니다."));
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (expired)
        throw new AppError(408, "요청 본문 전송 시간이 초과되었습니다.");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        throw new AppError(413, "입력 데이터가 너무 큽니다.");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
export async function readJson(request: Request): Promise<Record<string, any>> {
  const bytes = await readLimited(request, 1024 * 1024);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AppError(400, "올바른 JSON 객체가 필요합니다.");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new AppError(400, "JSON 객체를 전달해 주세요.");
  return data as Record<string, any>;
}
export async function readMultipart(
  request: Request,
  maximum = 21 * 1024 * 1024,
) {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data;"))
    throw new AppError(400, "multipart 파일 요청이 필요합니다.");
  const bytes = await readLimited(request, maximum);
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "Content-Type": request.headers.get("content-type")! },
    }).formData();
  } catch {
    throw new AppError(400, "파일 요청 형식을 확인해 주세요.");
  }
  let files = 0,
    fields = 0;
  const keys = new Set<string>();
  for (const [key, value] of form) {
    if (keys.has(key))
      throw new AppError(400, "동일한 항목을 여러 번 전달할 수 없습니다.");
    keys.add(key);
    if (value instanceof File) files++;
    else {
      fields++;
      if (value.length > 20000)
        throw new AppError(413, "입력 항목이 너무 큽니다.");
    }
  }
  if (files !== 1 || fields > 12)
    throw new AppError(400, "한 번에 파일 한 개만 업로드해 주세요.");
  return form;
}
export function pagination(query: URLSearchParams, defaultLimit = 20) {
  function integer(name: string, fallback: number, max: number) {
    const raw = query.get(name);
    if (raw === null) return fallback;
    if (
      !/^[1-9]\d*$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) > max
    )
      throw new AppError(400, `${name}은 1~${max}의 정수여야 합니다.`);
    return Number(raw);
  }
  const page = integer("page", 1, 100000),
    limit = integer("limit", defaultLimit, 100),
    offset = (page - 1) * limit;
  if (offset > 10000000) throw new AppError(400, "페이지 범위를 초과했습니다.");
  return { page, limit, offset };
}
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AppError(400, "입력 항목과 형식을 확인해 주세요.");
  return parsed.data;
}

let uploadsInFlight = 0;
export async function withUploadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (uploadsInFlight >= 4)
    throw new AppError(429, "파일 처리 중입니다. 잠시 후 다시 시도해 주세요.");
  uploadsInFlight++;
  try {
    return await fn();
  } finally {
    uploadsInFlight--;
  }
}
export function queryDate(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new AppError(400, "유효한 날짜를 입력해 주세요.");
  return value;
}
