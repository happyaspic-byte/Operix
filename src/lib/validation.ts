import { z } from "zod";
import { catalog } from "./catalog";
import { validDate } from "./dates";
import { AppError } from "./policy";
export function validateEntity(
  kind: string,
  input: Record<string, unknown>,
): Record<string, any> {
  const config = catalog[kind];
  if (!config) throw new AppError(404, "자료 유형을 찾을 수 없습니다.");
  const shape: Record<string, z.ZodType> = {};
  for (const field of config.fields) {
    let schema: z.ZodType;
    if (field.type === "checklist")
      schema = z
        .array(
          z.object({
            label: z.string().trim().min(1).max(300),
            checked: z.boolean(),
          }),
        )
        .max(100)
        .default([]);
    else if (field.type === "assets")
      schema = z.array(z.string().uuid()).max(200).default([]);
    else if (field.type === "relation")
      schema = field.required
        ? z.string().uuid()
        : z.preprocess(
            (v) => (v === "" || v === undefined ? null : v),
            z.string().uuid().nullable(),
          );
    else if (field.type === "number")
      schema = z.preprocess(
        (v) =>
          v === "" || v === null || v === undefined
            ? null
            : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)
              ? Number(v)
              : v,
        field.required
          ? z
              .number()
              .int()
              .min(field.min ?? 0)
              .max(field.max ?? Number.MAX_SAFE_INTEGER)
          : z
              .number()
              .int()
              .min(field.min ?? 0)
              .max(field.max ?? Number.MAX_SAFE_INTEGER)
              .nullable(),
      );
    else if (field.type === "date") {
      const d = z.string().refine(validDate, "실제 날짜를 입력해 주세요.");
      schema = field.required
        ? d
        : z.preprocess(
            (v) => (v === "" || v === undefined ? null : v),
            d.nullable(),
          );
    } else if (field.type === "select")
      schema = z
        .enum(field.options!.map((o) => o[0]) as [string, ...string[]])
        .default(field.options![0][0]);
    else {
      let s = z
        .string()
        .trim()
        .max(field.type === "textarea" ? 10000 : 300);
      if (field.required) s = s.min(1);
      schema = s.default("");
    }
    shape[field.key] = schema;
  }
  const parsed = z.object(shape).strict().safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const label =
      config.fields.find((f) => f.key === issue.path[0])?.label || "입력 값";
    throw new AppError(400, `${label}: ${issue.message}`);
  }
  const data = parsed.data as Record<string, any>;
  if (kind === "assets") data.asset_tag = data.asset_tag || null;
  if (
    ["customers", "customer_contacts"].includes(kind) &&
    data.email &&
    !z.email().safeParse(data.email).success
  )
    throw new AppError(400, "이메일 형식을 확인해 주세요.");
  if (kind === "contracts") {
    data.notice_days ||= 90;
    if (data.term === "dated" && !data.end_date)
      throw new AppError(400, "기간 지정 계약은 종료일이 필요합니다.");
    if (data.term !== "dated") data.end_date = null;
    if (data.start_date && data.end_date && data.start_date > data.end_date)
      throw new AppError(400, "종료일은 시작일보다 빠를 수 없습니다.");
  }
  if (kind === "maintenance_plans")
    data.interval_months = Number(data.interval_months);
  if (kind === "inspections" && data.status === "completed") {
    if (!data.result?.trim())
      throw new AppError(400, "점검을 완료하려면 결과를 작성해 주세요.");
    if (data.checklist.some((i: { checked: boolean }) => !i.checked))
      throw new AppError(400, "모든 점검 항목을 확인한 뒤 완료해 주세요.");
  }
  if (
    kind === "tickets" &&
    ["resolved", "closed"].includes(data.status) &&
    !data.resolution?.trim()
  )
    throw new AppError(400, "해결·종결하려면 조치 결과를 작성해 주세요.");
  return data;
}
