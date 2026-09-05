"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ErrorNotice, Badge } from "./ui";
import { Pager } from "./documents";
import { todayKST, addDays, recurringDate } from "@/lib/dates";
export function Calendar() {
  const [date, setDate] = useState(todayKST()),
    [view, setView] = useState("month"),
    [page, setPage] = useState(1),
    [data, setData] = useState<{ rows: any[]; total: number }>({
      rows: [],
      total: 0,
    }),
    [error, setError] = useState("");
  const monthStart = date.slice(0, 7) + "-01",
    anchor = view === "month" ? monthStart : date,
    start = addDays(anchor, -new Date(anchor + "T00:00:00Z").getUTCDay()),
    length = view === "month" ? 42 : 7,
    end = addDays(start, length - 1);
  useEffect(() => {
    const q = new URLSearchParams({
      from: start,
      to: end,
      date_field: "planned_date",
      limit: "100",
      page: String(page),
    });
    api("/api/data/inspections?" + q)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [start, end, page]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>점검 일정</h1>
          <p>회차를 선택해 일정·담당자 변경 또는 취소를 기록합니다.</p>
        </div>
        <Link className="button" href="/inspections">
          목록 보기
        </Link>
      </div>
      <div className="list-toolbar">
        <select
          aria-label="일정 보기"
          value={view}
          onChange={(e) => {
            setView(e.target.value);
            setPage(1);
          }}
        >
          <option value="month">월간</option>
          <option value="week">주간</option>
        </select>
        <label>
          기준일
          <input
            type="date"
            required
            value={date}
            onChange={(e) => {
              if (e.target.value) {
                setDate(e.target.value);
                setPage(1);
              }
            }}
          />
        </label>
        <button
          className="button"
          onClick={() => {
            setDate(
              view === "week"
                ? addDays(date, -7)
                : recurringDate(monthStart, 1, -1),
            );
            setPage(1);
          }}
        >
          이전 기간
        </button>
        <button
          className="button"
          onClick={() => {
            setDate(
              view === "week"
                ? addDays(date, 7)
                : recurringDate(monthStart, 1, 1),
            );
            setPage(1);
          }}
        >
          다음 기간
        </button>
      </div>
      <ErrorNotice message={error} />
      <section className="panel">
        <div className="calendar-scroll">
          <div className="calendar-grid">
            {Array.from({ length }, (_, i) => addDays(start, i)).map((day) => (
              <div className="calendar-day" key={day}>
                <strong>
                  {day.slice(5)}{" "}
                  {
                    ["일", "월", "화", "수", "목", "금", "토"][
                      new Date(day + "T00:00:00Z").getUTCDay()
                    ]
                  }
                </strong>
                {data.rows
                  .filter((r) => r.planned_date === day)
                  .map((r) => (
                    <Link href={"/inspections/" + r.id} key={r.id}>
                      <Badge value={r.status} />
                      <span>{r.name}</span>
                      <small>{r.assignee_name || "담당 미지정"}</small>
                    </Link>
                  ))}
              </div>
            ))}
          </div>
        </div>
        <Pager page={page} total={data.total} limit={100} onPage={setPage} />
      </section>
    </>
  );
}
