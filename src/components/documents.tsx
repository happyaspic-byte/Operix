"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, ErrorNotice, Loading, Empty, useUser } from "./ui";
import { DocumentDownload, type DocumentView } from "./document-download";
import { classificationNames, readableClasses } from "@/lib/document-policy";
import { catalog } from "@/lib/catalog";
import { formatDate } from "@/lib/dates";
import { can } from "@/lib/policy";

type LookupRow = { id: string; name: string };
type SearchRow = DocumentView & {
  title: string;
  audience: string;
  revision: number;
  created_at: string;
  entity_kind: string;
  entity_id: string;
  entity_deleted_at: string | null;
};

function LookupFilter({
  entity,
  label,
  value,
  onChange,
}: {
  entity: "customers" | "users";
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<LookupRow[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      api("/api/lookups?" + new URLSearchParams({ entity, q: query }), {
        signal: abort.signal,
      })
        .then((result) => {
          setRows(result[entity]);
          setError("");
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [entity, query]);
  return (
    <>
      <input
        aria-label={`${label} 검색`}
        placeholder={`${label} 검색`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <select
        aria-label={`${label} 필터`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">모든 {label}</option>
        {value && !rows.some((row) => row.id === value) && (
          <option value={value}>{value}</option>
        )}
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
          </option>
        ))}
      </select>
      <ErrorNotice message={error} />
    </>
  );
}

export function Documents() {
  return (
    <Suspense fallback={<Loading />}>
      <DocumentsContent />
    </Suspense>
  );
}

function DocumentsContent() {
  const user = useUser(),
    searchParams = useSearchParams(),
    tab = searchParams.get("tab") === "documents" ? "documents" : "reports",
    page = Math.max(
      1,
      Number.parseInt(searchParams.get("page") || "1", 10) || 1,
    ),
    q = searchParams.get("q") || "",
    from = searchParams.get("from") || "",
    to = searchParams.get("to") || "",
    classification = searchParams.get("classification") || "",
    customerId = searchParams.get("customer_id") || "",
    entityKind = searchParams.get("entity_kind") || "",
    scanStatus = searchParams.get("scan_status") || "",
    uploaderId = searchParams.get("uploader_id") || "",
    [data, setData] = useState<{
      rows: SearchRow[];
      total: number;
      key: string;
    } | null>(null),
    [error, setError] = useState(""),
    [searchError, setSearchError] = useState<{
      key: string;
      message: string;
    } | null>(null),
    [lookupRevision, resetLookups] = useState(0),
    [revision, refresh] = useState(0);
  const requestKey = JSON.stringify([
    tab,
    page,
    q,
    from,
    to,
    classification,
    customerId,
    entityKind,
    scanStatus,
    uploaderId,
    revision,
  ]);
  const visibleData = data?.key === requestKey ? data : null;
  const visibleSearchError =
    searchError?.key === requestKey ? searchError.message : "";
  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(window.location.search);
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== "page") params.delete("page");
    const query = params.toString();
    window.history.pushState(
      null,
      "",
      window.location.pathname +
        (query ? `?${query}` : "") +
        window.location.hash,
    );
  }
  function resetFilters() {
    const params = new URLSearchParams(window.location.search);
    for (const key of [
      "page",
      "q",
      "from",
      "to",
      "classification",
      "customer_id",
      "entity_kind",
      "scan_status",
      "uploader_id",
    ])
      params.delete(key);
    const query = params.toString();
    window.history.pushState(
      null,
      "",
      window.location.pathname +
        (query ? `?${query}` : "") +
        window.location.hash,
    );
    resetLookups((n) => n + 1);
  }
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
            customer_id: customerId,
            entity_kind: entityKind,
            uploader_id: uploaderId,
            ...(tab === "documents" ? { scan_status: scanStatus } : {}),
          }),
        { signal: abort.signal },
      )
        .then((result) => {
          setData({ ...result, key: requestKey });
          setSearchError(null);
        })
        .catch((e) => {
          if (e.name !== "AbortError")
            setSearchError({ key: requestKey, message: e.message });
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    tab,
    page,
    q,
    from,
    to,
    classification,
    customerId,
    entityKind,
    scanStatus,
    uploaderId,
    revision,
    requestKey,
  ]);
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
            onClick={() => updateParam("tab", key)}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorNotice message={visibleSearchError || error} />
      <section className="panel">
        <div className="list-toolbar">
          <input
            aria-label="문서 검색"
            placeholder="제목 검색"
            value={q}
            onChange={(e) => updateParam("q", e.target.value)}
          />
          <label>
            시작일
            <input
              type="date"
              value={from}
              onChange={(e) => updateParam("from", e.target.value)}
            />
          </label>
          <label>
            종료일
            <input
              type="date"
              value={to}
              onChange={(e) => updateParam("to", e.target.value)}
            />
          </label>
          <LookupFilter
            key={`customers-${lookupRevision}`}
            entity="customers"
            label="고객사"
            value={customerId}
            onChange={(value) => updateParam("customer_id", value)}
          />
          <select
            aria-label="관련 기록 유형 필터"
            value={entityKind}
            onChange={(e) => updateParam("entity_kind", e.target.value)}
          >
            <option value="">모든 기록 유형</option>
            {Object.entries(catalog).map(([key, config]) => (
              <option key={key} value={key}>
                {config.singular}
              </option>
            ))}
          </select>
          <select
            aria-label="문서 분류 필터"
            value={classification}
            onChange={(e) => updateParam("classification", e.target.value)}
          >
            <option value="">모든 분류</option>
            {readableClasses(user.role).map((value) => (
              <option key={value} value={value}>
                {classificationNames[value]}
              </option>
            ))}
          </select>
          {tab === "documents" && (
            <select
              aria-label="검사 상태 필터"
              value={scanStatus}
              onChange={(e) => updateParam("scan_status", e.target.value)}
            >
              <option value="">모든 검사 상태</option>
              <option value="pending">검사 대기</option>
              <option value="clean">검사 완료</option>
              <option value="infected">위험 파일 차단</option>
              <option value="error">검사 실패</option>
            </select>
          )}
          {tab === "reports" && (
            <span className="muted">
              보고서는 파일 검사 상태 필터가 적용되지 않습니다. 업로더는 보고서
              승인자입니다.
            </span>
          )}
          <LookupFilter
            key={`users-${lookupRevision}`}
            entity="users"
            label="업로더"
            value={uploaderId}
            onChange={(value) => updateParam("uploader_id", value)}
          />
          <button type="button" className="button" onClick={resetFilters}>
            필터 초기화
          </button>
        </div>
        {!visibleData ? (
          visibleSearchError ? null : (
            <Loading />
          )
        ) : visibleData.rows.length ? (
          <div className="document-list">
            {visibleData.rows.map((d) => (
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
                {tab === "documents" && d.entity_deleted_at && (
                  <span className="muted">휴지통 점검 · 읽기 전용</span>
                )}
                {tab === "documents" &&
                  !d.entity_deleted_at &&
                  can(user.role, "reports:approve") && (
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
                      {readableClasses(user.role).map((value) => (
                        <option key={value} value={value}>
                          {classificationNames[value]}
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
        <Pager
          page={page}
          total={visibleData?.total || 0}
          onPage={(value) =>
            updateParam("page", value === 1 ? "" : String(value))
          }
        />
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
