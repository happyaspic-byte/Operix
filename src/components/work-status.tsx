"use client";
import { useEffect, useState } from "react";
import { api, ErrorNotice } from "./ui";
import { labels } from "@/lib/catalog";
export function WorkStatus({ record }: { record: any }) {
  const [history, setHistory] = useState<any[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    api("/api/workflow?entity_id=" + record.id)
      .then(setHistory)
      .catch((e) => setError(e.message));
  }, [record.id, record.version]);
  const display = (v: string | null) =>
    v
      ? new Date(v).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
      : "미지정";
  return (
    <section className="panel settings-section">
      <div className="panel-heading">
        <h2>처리 시간과 상태 이력</h2>
      </div>
      <ErrorNotice message={error} />
      {"response_due_at" in record && (
        <dl className="detail-fields">
          {[
            ["response_due_at", "응답 목표"],
            ["first_response_at", "최초 응답"],
            ["resolution_due_at", "해결 목표"],
            ["resolved_at", "해결 시각"],
            ["closed_at", "종결 시각"],
          ].map(([k, l]) => (
            <div key={k}>
              <dt>{l}</dt>
              <dd>{display(record[k])}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="timeline">
        {history.map((h) => (
          <article key={h.id}>
            <strong>
              {h.from_status ? labels[h.from_status] + " → " : ""}
              {labels[h.to_status]}
            </strong>
            <small>
              {" "}
              · {h.user_name || "시스템"} · {display(h.created_at)}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}
