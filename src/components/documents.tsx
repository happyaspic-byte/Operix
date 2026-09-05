"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ErrorNotice, Loading, Empty, useUser } from "./ui";
import { DocumentDownload, type DocumentView } from "./document-download";
import { classificationNames } from "@/lib/document-policy";
import { formatDate } from "@/lib/dates";
import { can } from "@/lib/policy";
export function Documents() {
  const user = useUser(),
    [tab, setTab] = useState("reports"),
    [page, setPage] = useState(1),
    [q, setQ] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [classification, setClassification] = useState(""),
    [data, setData] = useState<{ rows: any[]; total: number } | null>(null),
    [error, setError] = useState(""),
    [revision, refresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      api(
        "/api/" +
          tab +
          "?" +
          new URLSearchParams({
            page: String(page),
            q,
            from,
            to,
            classification,
          }),
        { signal: abort.signal },
      )
        .then(setData)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [tab, page, q, from, to, classification, revision]);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">TEAM KNOWLEDGE</div>
          <h1>문서·보고서</h1>
          <p>열람 권한이 있는 자료를 검색하고 확인합니다.</p>
        </div>
      </div>
      <div className="tabs">
        {[
          ["reports", "확정 보고서"],
          ["documents", "첨부 자료"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => {
              setTab(key);
              setPage(1);
              setData(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorNotice message={error} />
      <section className="panel">
        <div className="list-toolbar">
          <input
            aria-label="문서 검색"
            placeholder="제목 검색"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          <label>
            시작일
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            종료일
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {tab === "documents" && (
            <select
              aria-label="문서 분류 필터"
              value={classification}
              onChange={(e) => {
                setClassification(e.target.value);
                setPage(1);
              }}
            >
              <option value="">모든 분류</option>
              {Object.entries(classificationNames).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          )}
        </div>
        {!data ? (
          <Loading />
        ) : data.rows.length ? (
          <div className="document-list">
            {data.rows.map((d) => (
              <div className="document-row" key={d.id}>
                <div>
                  {tab === "reports" ? (
                    <Link href={"/reports/" + d.id}>
                      <strong>{d.title}</strong>
                      <small>
                        {d.audience === "customer"
                          ? "고객 제출용"
                          : "내부 검토용"}{" "}
                        · 버전 {d.revision} · {formatDate(d.created_at)}
                      </small>
                    </Link>
                  ) : (
                    <DocumentDownload doc={d as DocumentView} />
                  )}
                </div>
                <Link
                  className="text-link"
                  href={`/${d.entity_kind}/${d.entity_id}`}
                >
                  관련 기록
                </Link>
                {tab === "documents" && can(user.role, "reports:approve") && (
                  <select
                    aria-label={`${d.name} 분류 변경`}
                    value={d.classification}
                    onChange={async (e) => {
                      try {
                        await api("/api/documents/" + d.id, {
                          method: "PATCH",
                          body: JSON.stringify({
                            classification: e.target.value,
                            version: d.version,
                            rescan: d.scan_status === "error",
                          }),
                        });
                        refresh((n) => n + 1);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    {Object.entries(classificationNames).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty title="조건에 맞는 문서가 없습니다." />
        )}
        <Pager page={page} total={data?.total || 0} onPage={setPage} />
      </section>
    </>
  );
}
export function Pager({
  page,
  total,
  onPage,
  limit = 20,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
  limit?: number;
}) {
  return (
    <div className="table-footer">
      <span>
        총 <strong>{total}</strong>건
      </span>
      <div>
        <button
          className="button small"
          aria-label="이전 페이지"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          이전
        </button>
        <span>
          {page} / {Math.max(1, Math.ceil(total / limit))}
        </span>
        <button
          className="button small"
          aria-label="다음 페이지"
          disabled={page * limit >= total}
          onClick={() => onPage(page + 1)}
        >
          다음
        </button>
      </div>
    </div>
  );
}
