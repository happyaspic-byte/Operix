"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FileText, Paperclip, ArrowUpRight, Download } from "lucide-react";
import { api, Loading, ErrorNotice, Empty } from "./ui";
import { formatDate } from "@/lib/dates";
import { catalog } from "@/lib/catalog";
export function Documents() {
  const [docs, setDocs] = useState<any[] | null>(null),
    [reports, setReports] = useState<any[]>([]),
    [tab, setTab] = useState("reports"),
    [error, setError] = useState("");
  useEffect(() => {
    Promise.all([api("/api/documents"), api("/api/reports")])
      .then(([d, r]) => {
        setDocs(d);
        setReports(r);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">TEAM KNOWLEDGE</div>
          <h1>문서·보고서</h1>
          <p>현장의 자료와 확정된 작업 보고서를 찾아보세요.</p>
        </div>
      </div>
      <div className="tabs">
        <button
          className={tab === "reports" ? "active" : ""}
          onClick={() => setTab("reports")}
        >
          확정 보고서<span>{reports.length}</span>
        </button>
        <button
          className={tab === "docs" ? "active" : ""}
          onClick={() => setTab("docs")}
        >
          첨부 자료<span>{docs?.length || 0}</span>
        </button>
      </div>
      <ErrorNotice message={error} />
      <section className="panel">
        {docs === null ? (
          <Loading />
        ) : tab === "reports" ? (
          reports.length ? (
            <div className="document-list">
              {reports.map((r) => (
                <Link
                  className="document-row"
                  href={"/reports/" + r.id}
                  key={r.id}
                >
                  <span className="document-icon">
                    <FileText />
                  </span>
                  <div>
                    <strong>{r.title}</strong>
                    <small>
                      버전 {r.revision} · {r.approved_name} ·{" "}
                      {formatDate(r.created_at)}
                    </small>
                  </div>
                  <ArrowUpRight size={17} />
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title="확정된 보고서가 없습니다."
              description="점검·장애 상세에서 업무를 완료한 후 보고서를 확정하세요."
            />
          )
        ) : docs.length ? (
          <div className="document-list">
            {docs.map((d) => (
              <div className="document-row" key={d.id}>
                <span className="document-icon">
                  <Paperclip />
                </span>
                <div>
                  <a className="primary-cell" href={"/api/documents/" + d.id}>
                    {d.name}
                  </a>
                  <small>
                    {catalog[d.entity_kind]?.singular} ·{" "}
                    {formatDate(d.created_at)} ·{" "}
                    {Math.round(d.size_bytes / 1024)} KB
                  </small>
                </div>
                <Link
                  className="text-link"
                  href={`/${d.entity_kind}/${d.entity_id}`}
                >
                  관련 기록 <ArrowUpRight size={14} />
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title="첨부 자료가 없습니다."
            description="고객·자산·작업 상세에서 문서와 사진을 첨부할 수 있습니다."
          />
        )}
      </section>
    </>
  );
}
