import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getReport } from "@/lib/reports";
import { securityLog } from "@/lib/security";
import { AppError } from "@/lib/policy";
import { DocumentDownload } from "@/components/document-download";
import { formatDate } from "@/lib/dates";
import { labels } from "@/lib/catalog";
import { PrintButton } from "@/components/print-button";
export default async function Report({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const u = await requireUser(),
    id = (await params).id;
  let r;
  try {
    r = await getReport(u, id);
    await securityLog(u, { action: "read_report", kind: "reports", ids: [id] });
  } catch (e) {
    if (e instanceof AppError && [403, 404].includes(e.status)) {
      await securityLog(u, {
        action: "read_report",
        kind: "reports",
        ids: [id],
        outcome: "denied",
      });
      notFound();
    }
    throw e;
  }
  const s = r.snapshot,
    d = s.record;
  return (
    <>
      <div className="page-heading no-print">
        <Link className="back-link" href={`/${r.entity_kind}/${r.entity_id}`}>
          ← 원본 작업으로
        </Link>
        <PrintButton />
      </div>
      <article className="report-paper">
        <header>
          <span className="report-brand">Operix.</span>
          <span>FIELD SERVICE REPORT</span>
        </header>
        <div className="report-title">
          <p>
            {r.entity_kind === "inspections"
              ? "점검 결과 보고서"
              : "작업 결과 보고서"}
          </p>
          <h1>{r.title}</h1>
          <small>
            {r.audience === "customer" ? "고객 제출용" : "내부 검토용"} · 확정
            버전 {r.revision} · {formatDate(r.created_at)}
          </small>
        </div>
        <dl className="report-meta">
          <div>
            <dt>고객사</dt>
            <dd>{d.customer_name || "—"}</dd>
          </div>
          <div>
            <dt>대상 자산</dt>
            <dd>{d.asset_name || "관련 작업 기록 참조"}</dd>
          </div>
          <div>
            <dt>담당자</dt>
            <dd>{d.assignee_name || "—"}</dd>
          </div>
          <div>
            <dt>확정자</dt>
            <dd>{s.approved_name}</dd>
          </div>
          <div>
            <dt>{r.entity_kind === "tickets" ? "접수일" : "예정일"}</dt>
            <dd>{formatDate(d.planned_date || d.created_at)}</dd>
          </div>
          <div>
            <dt>상태</dt>
            <dd>{labels[d.status]}</dd>
          </div>
        </dl>
        {d.description && (
          <section>
            <h2>요청·증상</h2>
            <p>{d.description}</p>
          </section>
        )}
        {d.checklist?.length > 0 && (
          <section>
            <h2>점검 항목</h2>
            <table>
              <thead>
                <tr>
                  <th>확인</th>
                  <th>점검 내용</th>
                </tr>
              </thead>
              <tbody>
                {d.checklist.map((c: any, i: number) => (
                  <tr key={i}>
                    <td>{c.checked ? "완료" : "미확인"}</td>
                    <td>{c.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <section>
          <h2>결과 및 조치 내용</h2>
          {d.evidence_level && (
            <small>근거 구분: {labels[d.evidence_level]}</small>
          )}
          <p>{d.result || d.resolution || "—"}</p>
        </section>
        {d.follow_up && (
          <section>
            <h2>후속 조치</h2>
            <p>{d.follow_up}</p>
          </section>
        )}
        {s.entries.length > 0 && (
          <section>
            <h2>작업 기록</h2>
            {s.entries.map((e: any, i: number) => (
              <div className="report-entry" key={i}>
                <small>
                  {e.user_name} · {labels[e.evidence_level]} ·{" "}
                  {formatDate(e.created_at)}
                </small>
                <p>{e.body}</p>
              </div>
            ))}
          </section>
        )}
        {s.documents.length > 0 && (
          <section>
            <h2>첨부 자료</h2>
            {s.documents.map((f: any) => (
              <p key={f.id}>
                <DocumentDownload doc={f} />
              </p>
            ))}
          </section>
        )}
        <footer>
          발행 사유: {r.issue_reason || "이전 버전에서 생성"}
          <br />
          본 문서는 확정 시점의 기록을 보존한 보고서입니다.
          <br />
          <span className="mono">
            {r.document_number || r.id} · v{r.revision}
          </span>
        </footer>
      </article>
    </>
  );
}
