"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Search,
  Plus,
  Download,
  Upload,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { catalog } from "@/lib/catalog";
import { can } from "@/lib/policy";
import { api, useUser, ErrorNotice, Loading, Empty } from "./ui";
import { RecordEditor } from "./record-editor";
import { RecordTable } from "./record-table";
import { ImportDialog } from "./import-dialog";
export function EntityList({ entity }: { entity: string }) {
  const user = useUser(),
    [kind, setKind] = useState(entity),
    [ready, setReady] = useState(false),
    [mine, setMine] = useState(false),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [expiry, setExpiry] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [trash, setTrash] = useState(false),
    [sort, setSort] = useState("created_at"),
    [page, setPage] = useState(1),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [editor, setEditor] = useState(false),
    [importer, setImporter] = useState(false),
    [revision, setRevision] = useState(0),
    [columns, setColumns] = useState<string[]>([]),
    [presets, setPresets] = useState<any[]>([]);
  const config = catalog[kind];
  const canViewTrash = kind === "inspections" && can(user.role, "work:delete");
  const showTrash = canViewTrash && trash;
  useEffect(() => {
    function restore() {
      const p = new URLSearchParams(location.search);
      const requested = p.get("view");
      setKind(
        requested && Object.hasOwn(catalog, requested) ? requested : entity,
      );
      setQuery(p.get("q") || "");
      setStatus(p.get("status") || "");
      setTrash(p.get("trash") === "1");
      setSort(p.get("sort") || "created_at");
      setPage(Math.max(1, Number(p.get("page")) || 1));
      setMine(p.get("mine") === "1");
      setFrom(p.get("from") || "");
      setTo(p.get("to") || "");
      setExpiry(p.get("expiry") || "");
      if (p.get("new") === "1" && p.get("trash") !== "1") setEditor(true);
      setReady(true);
    }
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [entity]);
  const filters = new URLSearchParams({
    view: kind,
    q: query,
    page: String(page),
    status,
    ...(kind === "inspections" ? { trash: showTrash ? "1" : "" } : {}),
    sort,
    direction: sort === "name" ? "asc" : "desc",
    mine: mine ? "1" : "",
    from,
    to,
    expiry,
    date_field:
      kind === "inspections"
        ? "planned_date"
        : kind === "contracts"
          ? "end_date"
          : "created_at",
  });
  useEffect(() => {
    if (ready)
      window.history.replaceState(
        null,
        "",
        "/" + entity + "?" + filters.toString(),
      );
  }, [
    ready,
    entity,
    kind,
    query,
    page,
    status,
    sort,
    mine,
    from,
    to,
    expiry,
    showTrash,
  ]);
  useEffect(() => {
    if (!ready) return;
    const c = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(
      () => {
        api(`/api/data/${kind}?` + filters.toString(), { signal: c.signal })
          .then((d) => {
            if (c.signal.aborted) return;
            setData(d);
            setError("");
          })
          .catch((e) => {
            if (!c.signal.aborted && e.name !== "AbortError") {
              setData(null);
              setError(e.message);
            }
          })
          .finally(() => {
            if (!c.signal.aborted) setLoading(false);
          });
      },
      query ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [
    ready,
    kind,
    query,
    status,
    page,
    sort,
    revision,
    mine,
    from,
    to,
    expiry,
    showTrash,
  ]);
  useEffect(() => {
    try {
      const preferences = JSON.parse(
        localStorage.getItem(`operix:view:${user.id}:${kind}`) || "{}",
      );
      setColumns(preferences.columns || catalog[kind].columns.map((c) => c[0]));
      setPresets(preferences.presets || []);
    } catch {
      setColumns(catalog[kind].columns.map((c) => c[0]));
      setPresets([]);
    }
  }, [kind, user.id]);
  function savePreference(nextColumns: string[], nextPresets: any[]) {
    setColumns(nextColumns);
    setPresets(nextPresets);
    try {
      localStorage.setItem(
        `operix:view:${user.id}:${kind}`,
        JSON.stringify({ columns: nextColumns, presets: nextPresets }),
      );
    } catch {
      setError("이 브라우저에서는 보기 설정을 저장할 수 없습니다.");
    }
  }
  function clearFilters() {
    setQuery("");
    setStatus("");
    setMine(false);
    setFrom("");
    setTo("");
    setExpiry("");
    setPage(1);
  }
  function toggleTrash() {
    const next = !showTrash;
    const nextFilters = new URLSearchParams(filters);
    nextFilters.set("trash", next ? "1" : "");
    nextFilters.set("page", "1");
    window.history.pushState(
      null,
      "",
      "/" + entity + "?" + nextFilters.toString(),
    );
    setTrash(next);
    setPage(1);
    setData(null);
  }
  const filtered = Boolean(query || status || mine || from || to || expiry);
  const statusField = config.fields.find((f) => f.key === "status");
  const tabs =
    entity === "customers"
      ? ["customers", "sites", "customer_contacts"]
      : entity === "inspections"
        ? ["inspections", "maintenance_plans"]
        : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {entity === "assets"
              ? "ASSET INVENTORY"
              : entity === "contracts"
                ? "CONTRACT MANAGEMENT"
                : entity === "tickets"
                  ? "SERVICE DESK"
                  : "WORKSPACE"}
          </div>
          <h1>{catalog[entity].title}</h1>
          <p>{catalog[entity].description}</p>
        </div>
        <div className="heading-actions">
          {entity === "inspections" && (
            <Link className="button" href="/calendar">
              주·월간 일정
            </Link>
          )}
          {["customers", "sites", "assets", "contracts"].includes(kind) &&
            can(user.role, config.permission) && (
              <button className="button" onClick={() => setImporter(true)}>
                <Upload size={16} />
                가져오기
              </button>
            )}
          {!showTrash && can(user.role, config.permission) && (
            <button className="button primary" onClick={() => setEditor(true)}>
              <Plus size={17} />
              {config.singular} 등록
            </button>
          )}
        </div>
      </div>
      {tabs.length > 0 && (
        <div className="tabs">
          {tabs.map((t) => (
            <button
              aria-pressed={kind === t}
              className={kind === t ? "active" : ""}
              key={t}
              onClick={() => {
                setKind(t);
                setPage(1);
                setStatus("");
                setTrash(false);
                setData(null);
              }}
            >
              {catalog[t].title}
            </button>
          ))}
        </div>
      )}
      <div className="panel list-panel">
        <div className="list-toolbar">
          <div className="list-search">
            <Search size={17} />
            <input
              aria-label={`${config.singular} 검색`}
              placeholder={`${config.singular} 이름${kind === "assets" ? ", 자산 ID, 고객사" : ""} 검색`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="toolbar-filters">
            {canViewTrash && (
              <button
                className="button trash-toggle"
                aria-pressed={showTrash}
                onClick={toggleTrash}
              >
                <Trash2 size={15} />
                휴지통
              </button>
            )}
            {statusField && (
              <select
                aria-label="상태 필터"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">모든 상태</option>
                {statusField.options?.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label="정렬"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="created_at">최근 등록순</option>
              <option value="name">이름순</option>
              {config.fields
                .filter((f) => f.type === "date")
                .map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}순
                  </option>
                ))}
            </select>
            <details className="export-menu">
              <summary className="button">
                <SlidersHorizontal size={15} />
                표시 열
              </summary>
              <div className="column-menu">
                {config.columns.map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={key === "name" || columns.includes(key)}
                      disabled={key === "name"}
                      onChange={(e) =>
                        savePreference(
                          e.target.checked
                            ? [...columns, key]
                            : columns.filter((c) => c !== key),
                          presets,
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </details>
            {can(user.role, "export") && (
              <details className="export-menu">
                <summary className="button">
                  <Download size={15} />
                  <span>내보내기</span>
                </summary>
                <div>
                  <a href={`/api/export/${kind}?${filters.toString()}`}>
                    현재 조건 XLSX
                  </a>
                  <a
                    href={`/api/export/${kind}?${filters.toString()}&format=csv`}
                  >
                    현재 조건 CSV
                  </a>
                </div>
              </details>
            )}
          </div>
        </div>
        <div className="view-preferences">
          {config.fields.some((f) =>
            ["assignee_id", "owner_id"].includes(f.key),
          ) && (
            <label className="inline-checkbox">
              <input
                type="checkbox"
                checked={mine}
                onChange={(e) => {
                  setMine(e.target.checked);
                  setPage(1);
                }}
              />
              내 담당 업무
            </label>
          )}
          <label>
            기간 시작
            <input
              aria-label="기간 시작"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            기간 종료
            <input
              aria-label="기간 종료"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {kind === "contracts" && (
            <select
              aria-label="계약 만료 필터"
              value={expiry}
              onChange={(e) => {
                setExpiry(e.target.value);
                setPage(1);
              }}
            >
              <option value="">모든 만료 상태</option>
              <option value="30">30일 이내 만료</option>
              <option value="overdue">이미 만료</option>
              <option value="unknown">기간 미확인</option>
              <option value="perpetual">무기한</option>
            </select>
          )}

          <select
            aria-label="저장한 필터"
            value=""
            onChange={(e) => {
              if (e.target.value === "clear") {
                savePreference(columns, []);
                return;
              }
              const preset = presets[Number(e.target.value)];
              if (preset) {
                setQuery(preset.query);
                setStatus(preset.status);
                setSort(preset.sort);
                setPage(1);
              }
            }}
          >
            <option value="">저장한 필터</option>
            {presets.map((p, i) => (
              <option key={i} value={i}>
                {p.label}
              </option>
            ))}
            {presets.length > 0 && (
              <option value="clear">저장한 필터 초기화</option>
            )}
          </select>
          <button
            className="button small"
            onClick={() => {
              const label = [
                query || "전체",
                statusField?.options?.find((o) => o[0] === status)?.[1] ||
                  "모든 상태",
              ].join(" · ");
              savePreference(
                columns,
                [
                  ...presets.filter((p) => p.label !== label),
                  { label, query, status, sort },
                ].slice(-5),
              );
            }}
          >
            현재 필터 저장
          </button>
          {filtered && (
            <button className="button small" onClick={clearFilters}>
              검색·필터 초기화
            </button>
          )}
          <small>보기 설정은 이 브라우저에 저장됩니다.</small>
        </div>
        {showTrash && (
          <p className="trash-list-notice" role="status">
            삭제한 점검만 표시합니다. 점검 상세에서 복원할 수 있습니다.
          </p>
        )}
        <ErrorNotice message={error} />
        {loading ? (
          <Loading />
        ) : data && showTrash && !filtered && !data.rows.length ? (
          <Empty
            title="휴지통이 비어 있습니다."
            description="삭제한 점검은 이곳에서 확인하고 복원할 수 있습니다."
          />
        ) : data ? (
          <RecordTable
            kind={kind}
            rows={data.rows}
            visibleColumns={columns}
            filtered={filtered}
          />
        ) : null}
        {data && (
          <div className="table-footer" aria-busy={loading}>
            <span>
              {loading ? (
                "조회 중…"
              ) : (
                <>
                  총 <strong>{data.total}</strong>건
                  {kind === "assets" ? " · 최근 확인 상태 기준" : ""}
                </>
              )}
            </span>
            <div>
              <button
                className="icon-button"
                aria-label="이전 페이지"
                aria-disabled={loading || page === 1}
                onClick={() => {
                  if (!loading && page > 1) setPage(page - 1);
                }}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {loading
                  ? "…"
                  : `${page} / ${Math.max(1, Math.ceil(data.total / 20))}`}
              </span>
              <button
                className="icon-button"
                aria-label="다음 페이지"
                aria-disabled={loading || page * 20 >= data.total}
                onClick={() => {
                  if (!loading && page * 20 < data.total) setPage(page + 1);
                }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
      {editor && (
        <RecordEditor
          kind={kind}
          onClose={() => setEditor(false)}
          onSaved={() => {
            setEditor(false);
            setRevision(revision + 1);
          }}
        />
      )}
      {importer && (
        <ImportDialog
          kind={kind}
          onClose={() => setImporter(false)}
          onDone={() => {
            setImporter(false);
            setRevision(revision + 1);
          }}
        />
      )}
    </>
  );
}
