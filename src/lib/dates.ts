export function todayKST(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function dayDiff(end: string, today = todayKST()): number {
  return Math.round(
    (Date.parse(end.slice(0, 10) + "T00:00:00Z") -
      Date.parse(today + "T00:00:00Z")) /
      86400000,
  );
}
export function validDate(value: string): boolean {
  const n = Date.parse(value + "T00:00:00Z");
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(n) &&
    new Date(n).toISOString().slice(0, 10) === value
  );
}
export function addDays(date: string, days: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function recurringDate(
  start: string,
  intervalMonths: number,
  index: number,
) {
  const d = new Date(start + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + intervalMonths * index);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
export function expiryLabel(
  end: string | null,
  term: string,
  today = todayKST(),
) {
  if (term === "perpetual")
    return { label: "무기한", tone: "neutral", days: null };
  if (!end || term === "unknown")
    return { label: "미확인", tone: "neutral", days: null };
  const days = dayDiff(end, today);
  return {
    label: days < 0 ? "만료" : days === 0 ? "오늘 만료" : `D−${days}`,
    tone:
      days < 0
        ? "danger"
        : days <= 30
          ? "warning"
          : days <= 90
            ? "info"
            : "success",
    days,
  };
}
export function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return value.replaceAll("-", ".");
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : todayKST(date).replaceAll("-", ".");
}
