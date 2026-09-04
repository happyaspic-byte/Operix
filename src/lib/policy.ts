export const roles = [
  "admin",
  "manager",
  "engineer",
  "sales",
  "viewer",
] as const;
export type Role = (typeof roles)[number];
export type Permission =
  | "customers:write"
  | "assets:write"
  | "contracts:write"
  | "work:write"
  | "reports:approve"
  | "users:write"
  | "export"
  | "network"
  | "money"
  | "audit";
const grants: Record<Role, Permission[]> = {
  admin: [
    "customers:write",
    "assets:write",
    "contracts:write",
    "work:write",
    "reports:approve",
    "users:write",
    "export",
    "network",
    "money",
    "audit",
  ],
  manager: [
    "customers:write",
    "assets:write",
    "contracts:write",
    "work:write",
    "reports:approve",
    "export",
    "network",
    "money",
    "audit",
  ],
  engineer: ["assets:write", "work:write", "network"],
  sales: ["customers:write", "contracts:write", "export", "money"],
  viewer: [],
};
export const roleNames: Record<Role, string> = {
  admin: "시스템 관리자",
  manager: "업무 관리자",
  engineer: "기술지원",
  sales: "영업·관리",
  viewer: "조회 전용",
};
export function can(role: Role, permission: Permission) {
  return grants[role]?.includes(permission) || false;
}
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requirePermission(role: Role, permission: Permission) {
  if (!can(role, permission))
    throw new AppError(403, "이 작업에 필요한 권한이 없습니다.");
}
export function redact<T extends Record<string, any>>(row: T, role: Role): T {
  const copy = { ...row };
  if (!can(role, "network")) {
    delete copy.management_ip;
    delete copy.network_notes;
  }
  if (!can(role, "money")) delete copy.amount;
  delete copy.password_hash;
  delete copy.token_hash;
  return copy;
}
