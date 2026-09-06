"use client";
import { useEffect, useState } from "react";
import {
  Search,
  Plus,
  Download,
  Upload,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react";
import { catalog } from "@/lib/catalog";
import { can } from "@/lib/policy";
import { api, useUser, ErrorNotice, Loading } from "./ui";
import { RecordEditor } from "./record-editor";
import { RecordTable } from "./record-table";
import { ImportDialog } from "./import-dialog";
export function EntityList({ entity }: { entity: string }) {
  const user = useUser(),
    [kind, setKind] = useState(entity),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
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
  useEffect(() => {
    setKind(entity);
    setPage(1);
    setStatus("");
    if (new URLSearchParams(window.location.search).get("new") === "1")
      setEditor(true);
  }, [entity]);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setData(null);
    setError("");
    const timer = setTimeout(
      () => {
        api(
          `/api/data/${kind}?q=${encodeURIComponent(query)}&page=${page}&status=${status}&sort=${sort}&direction=${sort === "name" ? "asc" : "desc"}`,
          { signal: c.signal },
        )
          .then((d) => {
            setData(d);
            setError("");
          })
          .catch((e) => {
            if (e.name !== "AbortError") setError(e.message);
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
  }, [kind, query, status, page, sort, revision]);
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
    setPage(1);
  }
  const filtered = Boolean(query || status);
  const statusField = config.fields.find((f) => f.key === "status");
  const tabs =
    entity === "customers"
      ? ["customers", "sites"]
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
          {kind === "assets" && can(user.role, "assets:write") && (
            <button className="button" onClick={() => setImporter(true)}>
              <Upload size={16} />
              가져오기
            </button>
          )}
          {can(user.role, config.permission) && (
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
                  <a href={`/api/export/${kind}`}>전체 XLSX</a>
                  <a href={`/api/export/${kind}?format=csv`}>전체 CSV</a>
                </div>
              </details>
            )}
          </div>
        </div>
        <div className="view-preferences">
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
        <ErrorNotice message={error} />
        {loading ? (
          <Loading />
        ) : data ? (
          <RecordTable
            kind={kind}
            rows={data.rows}
            visibleColumns={columns}
            filtered={filtered}
          />
        ) : null}
        {!loading && data && (
          <div className="table-footer">
            <span>
              총 <strong>{data?.total ?? 0}</strong>건
              {kind === "assets" ? " · 최근 확인 상태 기준" : ""}
            </span>
            <div>
              <button
                className="icon-button"
                aria-label="이전 페이지"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {page} / {Math.max(1, Math.ceil((data?.total || 0) / 20))}
              </span>
              <button
                className="icon-button"
                aria-label="다음 페이지"
                disabled={page * 20 >= (data?.total || 0)}
                onClick={() => setPage(page + 1)}
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
