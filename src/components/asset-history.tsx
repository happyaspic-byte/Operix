"use client";
import { useEffect, useState } from "react";
import { catalog } from "@/lib/catalog";
import { api, ErrorNotice, Loading } from "./ui";

type Diff = { key: string; label: string; before: unknown; after: unknown };
type Event = {
  id: string;
  timestamp: string;
  actor: string;
  label: string;
  action: string;
  diffs: Diff[];
  unavailable: boolean;
  redacted: boolean;
};
type Result = {
  events: Event[];
  total: number;
  limit: number;
  offset: number;
  comparison: null | {
    dates: string[];
    records: {
      id: string;
      kind: string;
      label: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      unavailable: boolean;
      diffs: Diff[];
    }[];
  };
};
const display = (value: unknown) =>
  value === null || value === undefined || value === ""
    ? "없음"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

export function AssetHistory({ id }: { id: string }) {
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [left, setLeft] = useState(""),
    [right, setRight] = useState("");
  const [params, setParams] = useState(""),
    [offset, setOffset] = useState(0);
  const [data, setData] = useState<Result | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    api(
      `/api/asset-history/${encodeURIComponent(id)}?${params}${params ? "&" : ""}offset=${offset}`,
    )
      .then((result) => {
        if (active) setData(result);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id, params, offset]);
  function apply(compare: boolean) {
    const query = new URLSearchParams();
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (compare) query.set("compare", `${left},${right}`);
    setOffset(0);
    setParams(query.toString());
  }
  let previous = "";
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>변경 이력</h2>
      </div>
      <div className="heading-actions">
        <label>
          시작일{" "}
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          종료일{" "}
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className="button" onClick={() => apply(false)}>
          기간 조회
        </button>
      </div>
      <div className="heading-actions">
        <label>
          비교 시작일{" "}
          <input
            type="date"
            value={left}
            onChange={(e) => setLeft(e.target.value)}
          />
        </label>
        <label>
          비교 종료일{" "}
          <input
            type="date"
            value={right}
            onChange={(e) => setRight(e.target.value)}
          />
        </label>
        <button
          className="button"
          disabled={!left || !right}
          onClick={() => apply(true)}
        >
          날짜 비교
        </button>
      </div>
      {error && <ErrorNotice message={error} />}
      {!data && !error && <Loading />}
      {data?.comparison && (
        <div>
          <h3>날짜 비교: {data.comparison.dates.join(" → ")}</h3>
          {data.comparison.records.map((record) => (
            <div key={record.id}>
              <strong>{record.label}</strong>
              {record.unavailable ? (
                <p>이전 이력은 값 비교 불가</p>
              ) : (
                catalog[record.kind].fields
                  .filter(
                    (field) =>
                      Object.hasOwn(record.before || {}, field.key) &&
                      Object.hasOwn(record.after || {}, field.key),
                  )
                  .map((field) => (
                    <p key={field.key}>
                      {field.label}: {display(record.before?.[field.key])} →{" "}
                      {display(record.after?.[field.key])}
                      {record.diffs.some((diff) => diff.key === field.key)
                        ? " (변경)"
                        : ""}
                    </p>
                  ))
              )}
            </div>
          ))}
        </div>
      )}
      <div className="history-list">
        {data?.events.map((event) => {
          const day = new Date(event.timestamp).toLocaleDateString("ko-KR", {
            timeZone: "Asia/Seoul",
          });
          const heading = day !== previous;
          previous = day;
          return (
            <div key={event.id}>
              {heading && <h3>{day}</h3>}
              <p>
                <strong>{event.label}</strong> · {event.actor || "관련 작업"} ·{" "}
                {new Date(event.timestamp).toLocaleTimeString("ko-KR", {
                  timeZone: "Asia/Seoul",
                })}
              </p>
              {event.redacted ? (
                <p>개인정보 파기됨</p>
              ) : event.unavailable ? (
                <p>이전 이력은 값 비교 불가</p>
              ) : (
                event.diffs.map((diff) => (
                  <p key={diff.key}>
                    {diff.label}: {display(diff.before)} → {display(diff.after)}
                  </p>
                ))
              )}
            </div>
          );
        })}
      </div>
      {data && !data.events.length && <p>해당 기간의 이력이 없습니다.</p>}
      {data && (
        <div className="heading-actions">
          <button
            className="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - data.limit))}
          >
            이전
          </button>
          <span>{data.total}건</span>
          <button
            className="button"
            disabled={offset + data.limit >= data.total}
            onClick={() => setOffset(offset + data.limit)}
          >
            다음
          </button>
        </div>
      )}
    </section>
  );
}
