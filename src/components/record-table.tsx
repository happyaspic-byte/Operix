"use client";
import Link from "next/link";
import { ArrowUpRight, Server, Building2 } from "lucide-react";
import { catalog, labels } from "@/lib/catalog";
import { formatDate } from "@/lib/dates";
import { Badge, Expiry, Empty } from "./ui";
export function RecordTable({
  kind,
  rows,
  visibleColumns,
  filtered = false,
}: {
  kind: string;
  rows: any[];
  visibleColumns?: string[];
  filtered?: boolean;
}) {
  const config = catalog[kind];
  const columns = visibleColumns?.length
    ? config.columns.filter(
        ([key]) => key === "name" || visibleColumns.includes(key),
      )
    : config.columns;
  if (!rows.length)
    return filtered ? (
      <Empty
        title="검색 조건에 맞는 자료가 없습니다."
        description="검색어 또는 상태를 바꾸거나 검색·필터를 초기화해 주세요."
      />
    ) : (
      <Empty />
    );
  return (
    <div
      className="table-scroll"
      role="region"
      aria-label={`${config.title} 표 · 가로 스크롤 가능`}
      tabIndex={0}
    >
      <table className="records-table">
        <caption className="sr-only">{config.title} 목록</caption>
        <thead>
          <tr>
            {columns.map(([key, label]) => (
              <th
                scope="col"
                key={key}
                className={
                  config.fields.find((f) => f.key === key)?.type === "number"
                    ? "numeric-cell"
                    : undefined
                }
              >
                {label}
              </th>
            ))}
            <th>
              <span className="sr-only">상세</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map(([key]) => (
                <td
                  key={key}
                  className={
                    config.fields.find((f) => f.key === key)?.type === "number"
                      ? "numeric-cell"
                      : undefined
                  }
                >
                  {key === "name" ? (
                    <Link
                      className="primary-cell record-name"
                      href={`/${kind}/${row.id}`}
                    >
                      {["assets", "customers"].includes(kind) && (
                        <span className={`record-icon ${kind}`}>
                          {kind === "assets" ? (
                            <Server size={16} />
                          ) : (
                            <Building2 size={16} />
                          )}
                        </span>
                      )}
                      <span>
                        {row.name}
                        {kind === "assets" && (
                          <small>
                            {row.model || row.software_version || "구성 확인"}
                          </small>
                        )}
                      </span>
                    </Link>
                  ) : key === "expiry" ? (
                    <Expiry end={row.end_date} term={row.term} />
                  ) : ["status", "severity", "renewal", "kind"].includes(
                      key,
                    ) ? (
                    <Badge
                      value={row[key]}
                      label={
                        kind === "assets" &&
                        key === "status" &&
                        row[key] === "critical"
                          ? "위험"
                          : undefined
                      }
                    />
                  ) : key.endsWith("_date") || key === "observed_at" ? (
                    <span className="mono date-cell">
                      {formatDate(row[key])}
                    </span>
                  ) : key === "customer_name" ? (
                    <>
                      <span>{row[key] || "—"}</span>
                      {row.site_name && <small>{row.site_name}</small>}
                    </>
                  ) : (
                    <span className={key === "asset_tag" ? "mono" : ""}>
                      {labels[String(row[key])] ||
                        String(row[key] ?? "—") ||
                        "—"}
                    </span>
                  )}
                </td>
              ))}
              <td>
                <Link
                  className="icon-button"
                  aria-label={`${row.name} 상세`}
                  href={`/${kind}/${row.id}`}
                >
                  <ArrowUpRight size={16} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
