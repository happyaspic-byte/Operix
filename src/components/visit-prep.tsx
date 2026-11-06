"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { labelFor } from "@/lib/catalog";
import { formatDate } from "@/lib/dates";
import { api, ErrorNotice, Loading } from "./ui";
import { PrintButton } from "./print-button";

type Item = {
  key: string;
  label: string;
  checked: boolean;
  updated_by_name?: string | null;
  updated_at?: string | null;
};
type Row = { [key: string]: string; checklist: string };
type Sheet = {
  inspection: Row;
  customer: Row;
  sites: Row[];
  contacts: Row[];
  assets: Row[];
  tickets: Row[];
  contracts: Row[];
  previous: Row[];
  documents: Row[];
  checks: Item[];
  can_edit: boolean;
};

export function VisitPrep({ id }: { id: string }) {
  const [data, setData] = useState<Sheet | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/api/visit-prep/" + encodeURIComponent(id))
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);
  async function toggle(item: Item) {
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/visit-prep/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ item_key: item.key, checked: !item.checked }),
      });
      setData((current) => current && { ...current, checks: result.checks });
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  if (!data) return error ? <ErrorNotice message={error} /> : <Loading />;
  const {
    inspection,
    customer,
    sites,
    contacts,
    assets,
    tickets,
    contracts,
    previous,
    documents,
    checks,
  } = data;
  const coverage: Record<string, string> = {
    active: "유효",
    expiring: "만료 임박",
    expired: "만료",
    unknown: "미확인",
  };
  return (
    <>
      <Link className="back-link no-print" href={"/inspections/" + id}>
        ← 점검 상세
      </Link>
      <div className="page-heading">
        <div>
          <h1>방문 준비표</h1>
          <p>
            {inspection.name} · {formatDate(inspection.planned_date)} ·{" "}
            {inspection.assignee_name || "담당자 미지정"} ·{" "}
            {labelFor(inspection.status) || inspection.status}
          </p>
        </div>
        <PrintButton />
      </div>
      <ErrorNotice message={error} />
      <section className="card">
        <h2>준비 체크리스트</h2>
        {checks.map((item: Item) => (
          <div key={item.key}>
            <label>
              <input
                type="checkbox"
                checked={item.checked}
                disabled={!data.can_edit || busy}
                onChange={() => toggle(item)}
              />{" "}
              {item.label}
            </label>
            {item.updated_at && (
              <small>
                {" "}
                · {item.updated_by_name} ·{" "}
                {new Date(item.updated_at).toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                })}
              </small>
            )}
          </div>
        ))}
      </section>
      <section className="card">
        <h2>고객사와 사업장</h2>
        <p>{customer?.name}</p>
        {sites.map((site: Row) => (
          <p key={site.id}>
            {site.name} · {site.address || "주소 미등록"} · {site.contact_name}{" "}
            {site.phone}
          </p>
        ))}
      </section>
      <section className="card">
        <h2>고객 담당자</h2>
        {contacts.length ? (
          contacts.map((c: Row) => (
            <p key={c.id}>
              {c.name} · {c.department} ·{" "}
              {labelFor(c.contact_role) || c.contact_role} ·{" "}
              {c.phone || "연락처 미등록"} · {c.email}
            </p>
          ))
        ) : (
          <p>등록된 담당자가 없습니다.</p>
        )}
      </section>
      <section className="card">
        <h2>대상 자산</h2>
        {assets.map((a: Row) => (
          <p key={a.id}>
            <Link href={"/assets/" + a.id}>{a.name}</Link> ·{" "}
            {a.asset_tag || "—"} · {a.product} · {a.model || "—"} ·{" "}
            {a.software_version || "—"} · {a.serial || "—"} · {a.protection} ·{" "}
            {labelFor(a.status) || a.status}
          </p>
        ))}
      </section>
      <section className="card">
        <h2>미해결 작업</h2>
        {tickets.length ? (
          tickets.map((t: Row) => (
            <p key={t.id}>
              <Link href={"/tickets/" + t.id}>{t.name}</Link> ·{" "}
              {labelFor(t.status) || t.status} ·{" "}
              {labelFor(t.severity) || t.severity}
            </p>
          ))
        ) : (
          <p>미해결 작업이 없습니다.</p>
        )}
      </section>
      <section className="card">
        <h2>계약·지원 현황</h2>
        {contracts.length ? (
          contracts.map((c: Row) => (
            <p key={c.id + c.asset_id}>
              <Link href={"/contracts/" + c.id}>{c.name}</Link> ·{" "}
              {assets.find((a: Row) => a.id === c.asset_id)?.name} ·{" "}
              {coverage[c.coverage_status]} · {formatDate(c.end_date)}
            </p>
          ))
        ) : (
          <p>연결된 계약이 없습니다.</p>
        )}
      </section>
      <section className="card">
        <h2>이전 완료 점검</h2>
        {previous.length ? (
          previous.map((p: Row) => (
            <div key={p.asset_id}>
              <h3>
                {assets.find((a: Row) => a.id === p.asset_id)?.name} ·{" "}
                <Link href={"/inspections/" + p.id}>{p.name}</Link> ·{" "}
                {formatDate(p.planned_date)}
              </h3>
              <p>
                점검 항목:{" "}
                {Array.isArray(p.checklist)
                  ? p.checklist
                      .map((entry: unknown) =>
                        typeof entry === "string"
                          ? entry
                          : JSON.stringify(entry),
                      )
                      .join(", ") || "없음"
                  : "없음"}
              </p>
              <p>결과: {p.result || "없음"}</p>
              <p>후속 조치: {p.follow_up || "없음"}</p>
            </div>
          ))
        ) : (
          <p>이전 완료 점검이 없습니다.</p>
        )}
      </section>
      <section className="card">
        <h2>관련 자료</h2>
        {documents.length ? (
          documents.map((d: Row) => (
            <p key={d.id}>
              <Link href={"/" + d.entity_kind + "/" + d.entity_id}>
                {d.name}
              </Link>{" "}
              · {d.entity_kind}
            </p>
          ))
        ) : (
          <p>열람 가능한 자료가 없습니다.</p>
        )}
      </section>
    </>
  );
}
