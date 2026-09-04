"use client";
import { createContext, useContext } from "react";
import type { User } from "@/lib/auth";
import { labels } from "@/lib/catalog";
import { expiryLabel } from "@/lib/dates";
export const UserContext = createContext<User | null>(null);
export function useUser() {
  return useContext(UserContext)!;
}
export async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !location.pathname.startsWith("/login"))
      location.assign("/login");
    throw new Error(data.error || "요청을 처리하지 못했습니다.");
  }
  return data;
}
export function Badge({ value, label }: { value: string; label?: string }) {
  const tone = [
    "normal",
    "completed",
    "resolved",
    "renewed",
    "active",
  ].includes(value)
    ? "success"
    : ["critical", "high", "overdue"].includes(value)
      ? "danger"
      : ["warning", "waiting", "contacted"].includes(value)
        ? "warning"
        : ["in_progress", "scheduled", "open", "quoted"].includes(value)
          ? "info"
          : "neutral";
  return (
    <span className={`badge ${tone}`}>
      <i />
      {label || labels[value] || value || "미확인"}
    </span>
  );
}
export function Expiry({ end, term }: { end: string | null; term: string }) {
  const e = expiryLabel(end, term);
  return <span className={`badge ${e.tone}`}>{e.label}</span>;
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      불러오는 중
    </div>
  );
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <div className="error-notice" role="alert">
      {message}
    </div>
  ) : null;
}
export function Empty({
  title = "아직 등록된 정보가 없습니다.",
  description = "새 자료를 등록하면 이곳에서 확인할 수 있습니다.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-symbol">＋</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}
