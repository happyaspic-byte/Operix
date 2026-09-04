"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Plus,
  Server,
  Building2,
  Clock3,
  LifeBuoy,
  CalendarDays,
  Activity,
  CheckCircle2,
} from "lucide-react";
import { api, useUser, Badge, Expiry, Loading, ErrorNotice, Empty } from "./ui";
import { formatDate, dayDiff } from "@/lib/dates";
import { catalog } from "@/lib/catalog";
export function Dashboard() {
  const user = useUser(),
    [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    api("/api/dashboard")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;
  const statuses = data.assetStatus,
    total = data.counts.assets,
    normal = statuses.find((s: any) => s.status === "normal")?.count || 0;
  const stats = [
    {
      label: "관리 자산",
      value: total,
      detail: `고객사 ${data.counts.customers}곳의 설치 시스템`,
      href: "/assets",
      icon: Server,
    },
    {
      label: "관리 고객사",
      value: data.counts.customers,
      detail: "사업장과 담당자 정보",
      href: "/customers",
      icon: Building2,
    },
    {
      label: "미해결 업무",
      value: data.counts.tickets,
      detail: "팀의 확인과 조치가 필요한 업무",
      href: "/tickets",
      icon: LifeBuoy,
    },
    {
      label: "지연 점검",
      value: data.counts.overdue,
      detail: data.counts.overdue
        ? "점검 일정 확인이 필요합니다"
        : "예정된 점검을 확인하세요",
      href: "/inspections",
      icon: Clock3,
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">OPERATIONS OVERVIEW</div>
          <h1>오늘의 운영 현황</h1>
          <p>{user.name}님, 고객과 현장의 업무를 여기에서 이어가세요.</p>
        </div>
        <div className="heading-actions">
          <span className="date-chip">
            <CalendarDays size={15} />
            {formatDate(data.today)}
          </span>
          <Link className="button primary" href="/tickets?new=1">
            <Plus size={17} />새 업무
          </Link>
        </div>
      </div>
      <div className="stats-grid">
        {stats.map((s, i) => (
          <Link
            key={s.label}
            href={s.href}
            className={`stat-card ${i === 0 ? "featured" : ""}`}
          >
            <div className="stat-top">
              <span>{s.label}</span>
              <s.icon size={19} />
            </div>
            <div className="stat-number">
              {s.value.toLocaleString()}
              <small>{i === 1 ? "곳" : "건"}</small>
            </div>
            <div className="stat-bottom">
              <span>{s.detail}</span>
              <ArrowUpRight size={16} />
            </div>
          </Link>
        ))}
      </div>
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>만료 예정 계약</h2>
                <p>90일 이내 종료 예정 및 지난 만료</p>
              </div>
              <Link className="text-link" href="/contracts">
                전체 보기 <ArrowRight size={14} />
              </Link>
            </div>
            {data.contracts.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>계약 / 고객사</th>
                      <th>구분</th>
                      <th>종료일</th>
                      <th>남은 기간</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.contracts.map((c: any) => (
                      <tr key={c.id}>
                        <td>
                          <Link
                            className="primary-cell"
                            href={`/contracts/${c.id}`}
                          >
                            {c.name}
                          </Link>
                          <small>{c.customer_name}</small>
                        </td>
                        <td>
                          <Badge value={c.kind} />
                        </td>
                        <td className="mono">{formatDate(c.end_date)}</td>
                        <td>
                          <Expiry end={c.end_date} term={c.term} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="다가오는 만료가 없습니다."
                description="계약을 등록하면 갱신 시점을 함께 확인할 수 있습니다."
              />
            )}
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>
                  진행 중인 장애·작업{" "}
                  <span className="count-pill">{data.counts.tickets}</span>
                </h2>
                <p>우선순위가 높은 업무부터 확인하세요.</p>
              </div>
              <Link className="text-link" href="/tickets">
                전체 보기 <ArrowRight size={14} />
              </Link>
            </div>
            {data.tickets.length ? (
              <div className="work-list">
                {data.tickets.map((t: any) => (
                  <Link
                    href={`/tickets/${t.id}`}
                    key={t.id}
                    className="work-row"
                  >
                    <span className={`work-indicator ${t.severity}`} />
                    <div>
                      <strong>{t.name}</strong>
                      <small>
                        {t.customer_name} <span>·</span>{" "}
                        {t.assignee_name || "담당자 미정"}
                      </small>
                    </div>
                    <Badge value={t.status} />
                    <ArrowUpRight size={16} />
                  </Link>
                ))}
              </div>
            ) : (
              <Empty title="미해결 업무가 없습니다." />
            )}
          </section>
          <section className="panel activity-panel">
            <div className="panel-heading">
              <h2>최근 활동</h2>
              <span className="muted">팀의 최신 기록</span>
            </div>
            {data.activity.length ? (
              <div className="activity-list">
                {data.activity.map((a: any) => (
                  <div className="activity-row" key={a.id}>
                    <span className="activity-dot">
                      <Activity size={13} />
                    </span>
                    <p>
                      <strong>{a.user_name || "시스템"}</strong> ·{" "}
                      {catalog[a.entity_kind]?.singular || "계정"}{" "}
                      {(
                        {
                          create: "등록",
                          update: "수정",
                          login: "로그인",
                          comment: "기록 추가",
                          approve_report: "보고서 확정",
                          upload: "첨부",
                          download: "다운로드",
                          export: "내보내기",
                          import: "가져오기",
                        } as any
                      )[a.action] || a.action}
                    </p>
                    <time>
                      {new Date(a.created_at).toLocaleTimeString("ko-KR", {
                        timeZone: "Asia/Seoul",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </time>
                  </div>
                ))}
              </div>
            ) : (
              <Empty />
            )}
          </section>
        </div>
        <aside className="dashboard-side">
          <section className="panel asset-health">
            <div className="panel-heading">
              <h2>자산 확인 상태</h2>
              <Server size={17} />
            </div>
            <div className="health-number">
              {normal}
              <span>/ {total}</span>
              <small>최근 점검에서 정상 확인</small>
            </div>
            <div
              className="status-bar"
              role="img"
              aria-label={`정상 ${normal}, 전체 ${total}`}
            >
              {statuses.map((s: any) => (
                <span
                  className={s.status}
                  key={s.status}
                  style={{ width: `${total ? (s.count / total) * 100 : 0}%` }}
                />
              ))}
            </div>
            <div className="health-legend">
              {["normal", "warning", "critical", "unknown"].map((st) => (
                <div key={st}>
                  <Badge
                    value={st}
                    label={st === "critical" ? "위험" : undefined}
                  />
                  <strong>
                    {statuses.find((s: any) => s.status === st)?.count || 0}
                  </strong>
                </div>
              ))}
            </div>
            <p className="footnote">각 자산의 최근 확인 기록 기준입니다.</p>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>다가오는 점검</h2>
              <Link
                className="icon-button"
                href="/inspections"
                aria-label="전체 점검 일정"
              >
                <ArrowUpRight size={17} />
              </Link>
            </div>
            {data.inspections.length ? (
              <div className="agenda-list">
                {data.inspections.map((i: any) => (
                  <Link
                    href={`/inspections/${i.id}`}
                    key={i.id}
                    className="agenda-row"
                  >
                    <div
                      className={`agenda-date ${dayDiff(i.planned_date, data.today) < 0 ? "overdue" : ""}`}
                    >
                      <span>{String(i.planned_date).slice(5, 7)}월</span>
                      <strong>{String(i.planned_date).slice(8, 10)}</strong>
                    </div>
                    <div>
                      <strong>{i.name}</strong>
                      <small>{i.customer_name}</small>
                      <small>
                        {i.assignee_name || "담당자 미정"}
                        {dayDiff(i.planned_date, data.today) < 0
                          ? " · 일정 지연"
                          : ""}
                      </small>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty title="예정된 점검이 없습니다." />
            )}
          </section>
          <div className="guide-card">
            <span className="guide-icon">
              <CheckCircle2 size={20} />
            </span>
            <h3>현장의 기록을 팀의 지식으로.</h3>
            <p>
              점검과 작업 결과를 남기면
              <br />
              다음 담당자에게도 이어집니다.
            </p>
            <Link href="/inspections">
              점검 기록하기 <ArrowRight size={14} />
            </Link>
          </div>
        </aside>
      </div>
    </>
  );
}
