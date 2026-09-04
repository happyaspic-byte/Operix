import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/dates";
import { labels } from "@/lib/catalog";
import { PrintButton } from "@/components/print-button";
export default async function Report({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const [r] = await (
    await getDb()
  ).query("SELECT * FROM reports WHERE id=$1", [(await params).id]);
  if (!r) notFound();
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
            확정 버전 {r.revision} · {formatDate(r.created_at)}
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
            <dt>예정일</dt>
            <dd>{formatDate(d.planned_date)}</dd>
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
                <a href={"/api/documents/" + f.id}>{f.name}</a>
              </p>
            ))}
          </section>
        )}
        <footer>
          본 문서는 확정 시점의 기록을 보존한 보고서입니다.
          <br />
          <span className="mono">
            문서 ID {r.id} · v{r.revision}
          </span>
        </footer>
      </article>
    </>
  );
}
