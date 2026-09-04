"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Pencil,
  Plus,
  Paperclip,
  FileText,
  CheckCircle2,
  Clock3,
  Send,
  Download,
  History,
  ExternalLink,
} from "lucide-react";
import { catalog, labels } from "@/lib/catalog";
import { can } from "@/lib/policy";
import { formatDate } from "@/lib/dates";
import { api, useUser, Badge, ErrorNotice, Loading, Empty, Expiry } from "./ui";
import { RecordEditor } from "./record-editor";
import { RecordTable } from "./record-table";
export function EntityDetail({ kind, id }: { kind: string; id: string }) {
  const user = useUser(),
    config = catalog[kind],
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [tab, setTab] = useState("overview"),
    [editor, setEditor] = useState<{ kind: string; initial?: any } | null>(
      null,
    ),
    [revision, setRevision] = useState(0),
    [body, setBody] = useState(""),
    [evidence, setEvidence] = useState("observed"),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/api/details/${kind}/${id}`)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, [kind, id, revision]);
  async function run(task: () => Promise<any>) {
    setError("");
    setBusy(true);
    try {
      await task();
      setRevision((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return error ? <ErrorNotice message={error} /> : <Loading />;
  const record = data.record,
    work = ["inspections", "tickets"].includes(kind);
  const writable =
    can(user.role, config.permission) &&
    !(
      user.role === "engineer" &&
      work &&
      record.assignee_id &&
      record.assignee_id !== user.id
    );
  const relationshipTabs = Object.keys(data.related);
  function renderValue(f: any) {
    const v = record[f.key];
    if (f.type === "assets")
      return (data.related.assets || []).map((a: any) => (
        <Link className="inline-link" key={a.id} href={"/assets/" + a.id}>
          {a.name}
        </Link>
      ));
    if (f.type === "checklist")
      return (
        <div className="checklist-read">
          {(v || []).map((c: any, i: number) => (
            <div key={i}>
              <CheckCircle2
                size={16}
                className={c.checked ? "checked" : "unchecked"}
              />
              {c.label}
            </div>
          ))}
        </div>
      );
    if (f.type === "relation") {
      const label =
        record[f.key.replace("_id", "_name")] ||
        record[
          f.key === "owner_id"
            ? "owner_name"
            : f.key === "assignee_id"
              ? "assignee_name"
              : f.key === "asset_id"
                ? "asset_name"
                : f.key === "site_id"
                  ? "site_name"
                  : "customer_name"
        ];
      return v && f.entity !== "users" ? (
        <Link className="inline-link" href={`/${f.entity}/${v}`}>
          {label || v}
        </Link>
      ) : (
        label || "미지정"
      );
    }
    if (f.type === "select")
      return (
        <Badge
          value={String(v)}
          label={f.options?.find((o: any) => o[0] === String(v))?.[1]}
        />
      );
    if (f.type === "date") return formatDate(v);
    if (f.key === "amount")
      return v === null ? "미입력" : Number(v).toLocaleString() + " 원";
    return v || "—";
  }
  return (
    <>
      <Link className="back-link" href={"/" + kind}>
        <ArrowLeft size={15} />
        {config.title}
      </Link>
      <div className="page-heading detail-heading">
        <div>
          <div className="detail-kicker">
            {config.singular}
            {record.asset_tag && (
              <span className="mono">{record.asset_tag}</span>
            )}
          </div>
          <h1>{record.name}</h1>
          <p>
            {[record.customer_name, record.site_name, record.asset_name]
              .filter(Boolean)
              .join(" · ") || config.description}
          </p>
        </div>
        <div className="heading-actions">
          {record.status && <Badge value={record.status} />}{" "}
          {kind === "contracts" && (
            <Expiry end={record.end_date} term={record.term} />
          )}{" "}
          {writable && (
            <button
              className="button"
              onClick={() => setEditor({ kind, initial: record })}
            >
              <Pencil size={16} />
              수정
            </button>
          )}
          {work && can(user.role, "reports:approve") && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                run(() =>
                  api("/api/reports", {
                    method: "POST",
                    body: JSON.stringify({ entity_kind: kind, entity_id: id }),
                  }),
                )
              }
            >
              <FileText size={16} />
              보고서 확정
            </button>
          )}
        </div>
      </div>
      <ErrorNotice message={error} />
      <div className="tabs">
        <button
          className={tab === "overview" ? "active" : ""}
          onClick={() => setTab("overview")}
        >
          개요
        </button>
        {relationshipTabs.map((k) => (
          <button
            className={tab === k ? "active" : ""}
            key={k}
            onClick={() => setTab(k)}
          >
            {catalog[k].title}
            <span>{data.related[k].length}</span>
          </button>
        ))}
        {work && (
          <button
            className={tab === "timeline" ? "active" : ""}
            onClick={() => setTab("timeline")}
          >
            작업 기록<span>{data.entries.length}</span>
          </button>
        )}
        <button
          className={tab === "documents" ? "active" : ""}
          onClick={() => setTab("documents")}
        >
          문서·보고서<span>{data.documents.length + data.reports.length}</span>
        </button>
        {can(user.role, "audit") && (
          <button
            className={tab === "history" ? "active" : ""}
            onClick={() => setTab("history")}
          >
            변경 이력
          </button>
        )}
      </div>
      {tab === "overview" && (
        <div className="detail-grid">
          <section className="panel">
            <div className="panel-heading">
              <h2>기본 정보</h2>
              <span className="muted">버전 {record.version}</span>
            </div>
            <dl className="detail-fields">
              {config.fields
                .filter((f) => !f.permission || can(user.role, f.permission))
                .map((f) => (
                  <div
                    className={
                      ["textarea", "checklist", "assets"].includes(f.type || "")
                        ? "full"
                        : ""
                    }
                    key={f.key}
                  >
                    <dt>{f.label}</dt>
                    <dd>{renderValue(f)}</dd>
                  </div>
                ))}
            </dl>
          </section>
          <aside>
            <section className="panel record-summary">
              <h3>이 기록의 연결</h3>
              {relationshipTabs.map((k) => (
                <button
                  className="summary-link"
                  onClick={() => setTab(k)}
                  key={k}
                >
                  <span>{catalog[k].title}</span>
                  <strong>{data.related[k].length}</strong>
                </button>
              ))}
              <div className="record-time">
                <Clock3 size={15} />
                <span>
                  최근 수정
                  <br />
                  <strong>{formatDate(record.updated_at)}</strong>
                </span>
              </div>
              <p className="footnote">
                내부 식별자
                <br />
                <span className="mono break-word">{record.id}</span>
              </p>
            </section>
          </aside>
        </div>
      )}
      {relationshipTabs.includes(tab) && (
        <section className="panel">
          <div className="panel-heading">
            <h2>{catalog[tab].title}</h2>
            {can(user.role, catalog[tab].permission) && (
              <button
                className="button small"
                onClick={() =>
                  setEditor({
                    kind: tab,
                    initial: {
                      ...(kind === "assets" ? { asset_id: id } : {}),
                      ...(kind === "customers" ? { customer_id: id } : {}),
                      ...(kind === "sites" ? { site_id: id } : {}),
                      ...(tab === "contracts" && kind === "assets"
                        ? { customer_id: record.customer_id, asset_ids: [id] }
                        : {}),
                      ...(tab === "tickets" && kind === "assets"
                        ? { customer_id: record.customer_id, asset_ids: [id] }
                        : {}),
                    },
                  })
                }
              >
                <Plus size={15} />
                {catalog[tab].singular} 등록
              </button>
            )}
          </div>
          <RecordTable kind={tab} rows={data.related[tab]} />
        </section>
      )}
      {tab === "timeline" && (
        <section className="panel">
          <div className="panel-heading">
            <h2>작업 기록</h2>
            <span className="muted">사실과 추정을 구분해 기록하세요.</span>
          </div>
          {writable && (
            <form
              className="comment-form"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await api("/api/entries", {
                    method: "POST",
                    body: JSON.stringify({
                      entity_kind: kind,
                      entity_id: id,
                      body,
                      evidence_level: evidence,
                    }),
                  });
                  setBody("");
                });
              }}
            >
              <label htmlFor="entry-body">조치 내용</label>
              <textarea
                id="entry-body"
                required
                rows={4}
                maxLength={10000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="확인한 증상, 조치 내용, 다음 작업을 기록하세요."
              />
              <div>
                <select
                  aria-label="근거 구분"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                >
                  <option value="observed">관찰 사실</option>
                  <option value="internal">내부 추정</option>
                  <option value="vendor">제조사 확인</option>
                </select>
                <button className="button primary" disabled={busy}>
                  <Send size={15} />
                  기록 추가
                </button>
              </div>
            </form>
          )}
          {data.entries.length ? (
            <div className="timeline">
              {data.entries.map((entry: any) => (
                <article key={entry.id}>
                  <div>
                    <strong>{entry.user_name}</strong>
                    <Badge value={entry.evidence_level} />
                    <time>
                      {new Date(entry.created_at).toLocaleString("ko-KR", {
                        timeZone: "Asia/Seoul",
                      })}
                    </time>
                  </div>
                  <p>{entry.body}</p>
                </article>
              ))}
            </div>
          ) : (
            <Empty title="아직 작업 기록이 없습니다." />
          )}
        </section>
      )}
      {tab === "documents" && (
        <section className="panel">
          <div className="panel-heading">
            <h2>첨부 자료와 확정 보고서</h2>
            {writable && (
              <label className="button small upload-button">
                <Paperclip size={15} />
                자료 첨부
                <input
                  className="sr-only"
                  aria-label="첨부 파일"
                  type="file"
                  accept=".png,.jpg,.jpeg,.pdf,.txt,.csv,.log,.zip,.docx,.xlsx"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      run(async () => {
                        const f = new FormData();
                        f.set("file", file);
                        f.set("entity_kind", kind);
                        f.set("entity_id", id);
                        await api("/api/documents", {
                          method: "POST",
                          body: f,
                        });
                      });
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
          <div className="document-list">
            {data.reports.map((report: any) => (
              <Link
                className="document-row"
                href={"/reports/" + report.id}
                key={report.id}
              >
                <span className="document-icon">
                  <FileText size={21} />
                </span>
                <div>
                  <strong>{report.title}</strong>
                  <small>
                    확정 보고서 · 버전 {report.revision} ·{" "}
                    {formatDate(report.created_at)}
                  </small>
                </div>
                <ExternalLink size={17} />
              </Link>
            ))}
            {data.documents.map((doc: any) => (
              <a
                className="document-row"
                href={"/api/documents/" + doc.id}
                key={doc.id}
              >
                <span className="document-icon">
                  <Paperclip size={21} />
                </span>
                <div>
                  <strong>{doc.name}</strong>
                  <small>
                    {Math.max(1, Math.round(Number(doc.size_bytes) / 1024))} KB
                    · {formatDate(doc.created_at)}
                  </small>
                </div>
                <Download size={17} />
              </a>
            ))}
          </div>
          {!data.reports.length && !data.documents.length && (
            <Empty
              title="첨부된 자료가 없습니다."
              description="사진과 문서를 첨부하거나, 완료 후 보고서를 확정하세요."
            />
          )}
        </section>
      )}
      {tab === "history" && (
        <section className="panel">
          <div className="panel-heading">
            <h2>변경 이력</h2>
            <History size={17} />
          </div>
          <div className="history-list">
            {data.history.map((h: any) => (
              <details key={h.id}>
                <summary>
                  {h.user_name || "시스템"} · {h.action}{" "}
                  <time>
                    {new Date(h.created_at).toLocaleString("ko-KR", {
                      timeZone: "Asia/Seoul",
                    })}
                  </time>
                </summary>
                <pre>{JSON.stringify(h.details, null, 2)}</pre>
              </details>
            ))}
          </div>
        </section>
      )}
      {editor && (
        <RecordEditor
          kind={editor.kind}
          initial={editor.initial}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
