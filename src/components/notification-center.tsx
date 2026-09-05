"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ErrorNotice } from "./ui";
import { Pager } from "./documents";
export function NotificationCenter() {
  const [data, setData] = useState<{ rows: any[]; total: number }>({
      rows: [],
      total: 0,
    }),
    [page, setPage] = useState(1),
    [read, setRead] = useState("unread"),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api(
        "/api/notifications?" +
          new URLSearchParams({ page: String(page), read, limit: "20" }),
        { headers: { "X-Operix-Background": "1" } },
      )
        .then((d) => {
          if (active) setData(d);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [page, read, revision]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>알림</h1>
          <p>점검·계약과 SLA 알림을 확인합니다.</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      <section className="panel">
        <div className="list-toolbar">
          <select
            aria-label="알림 읽음 필터"
            value={read}
            onChange={(e) => {
              setRead(e.target.value);
              setPage(1);
            }}
          >
            <option value="unread">읽지 않음</option>
            <option value="read">읽음</option>
            <option value="">전체</option>
          </select>
        </div>
        {data.rows.map((n) => (
          <div className="document-row" key={n.id}>
            <Link href={n.href}>
              <strong>{n.title}</strong>
              <small>{n.body}</small>
            </Link>
            {!n.read_at && (
              <button
                className="button small"
                onClick={async () => {
                  try {
                    await api("/api/notifications", {
                      method: "PATCH",
                      body: JSON.stringify({ ids: [n.id] }),
                    });
                    setRevision((n) => n + 1);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                읽음 표시
              </button>
            )}
          </div>
        ))}
        <Pager page={page} total={data.total} onPage={setPage} />
      </section>
    </>
  );
}
