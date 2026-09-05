import { AppError, can, type Role } from "./policy";
export const classifications = [
  "internal",
  "financial",
  "network",
  "restricted",
] as const;
export type Classification = (typeof classifications)[number];
export const classificationNames: Record<Classification, string> = {
  internal: "사내 공유",
  financial: "금액·계약 기밀",
  network: "내부 네트워크",
  restricted: "관리자 제한",
};
export function canReadClass(role: Role, value: string) {
  if (value === "internal") return true;
  if (value === "financial") return can(role, "money");
  if (value === "network") return can(role, "network");
  return value === "restricted" && ["admin", "manager"].includes(role);
}
export function readableClasses(role: Role) {
  return classifications.filter((c) => canReadClass(role, c));
}
export function validateClassification(
  role: Role,
  value: unknown,
): Classification {
  if (!classifications.includes(value as Classification))
    throw new AppError(400, "기밀등급을 선택해 주세요.");
  if (!canReadClass(role, String(value)))
    throw new AppError(403, "해당 기밀등급을 지정할 권한이 없습니다.");
  return value as Classification;
}
export function defaultClassification(kind: string): Classification {
  if (kind === "contracts") return "financial";
  if (["assets", "components", "vms"].includes(kind)) return "network";
  return "internal";
}
export function requireDocumentAccess(
  role: Role,
  doc: { classification: string; deleted_at?: unknown; scan_status?: string },
) {
  if (doc.deleted_at) throw new AppError(410, "파기된 자료입니다.");
  if (!canReadClass(role, doc.classification))
    throw new AppError(403, "이 자료의 기밀등급을 열람할 권한이 없습니다.");
  if (doc.scan_status && doc.scan_status !== "clean")
    throw new AppError(423, "파일 검사가 완료되지 않았거나 격리된 자료입니다.");
}
