"use client";
import { useEffect, useState } from "react";
import { api, ErrorNotice } from "./ui";
import { Pager } from "./documents";
export function SecurityReview() {
  const [data, setData] = useState<{ rows: any[]; total: number }>({
      rows: [],
      total: 0,
    }),
    [page, setPage] = useState(1),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [outcome, setOutcome] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    api(
      "/api/security?" +
        new URLSearchParams({ page: String(page), from, to, outcome }),
    )
      .then(setData)
      .catch((e) => setError(e.message));
  }, [page, from, to, outcome]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>접속기록 점검</h1>
          <p>열람·다운로드·반출과 접근 거부를 확인하고 점검 결과를 남깁니다.</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      {message && <p role="status">{message}</p>}
      <section className="panel">
        <div className="list-toolbar">
          <label>
            시작일
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            종료일
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <select
            aria-label="접속 결과 필터"
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              setPage(1);
            }}
          >
            <option value="">모든 결과</option>
            <option value="allowed">허용</option>
            <option value="denied">거부</option>
          </select>
        </div>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="접속기록 목록"
        >
          <table className="security-table">
            <thead>
              <tr>
                {[
                  "시각",
                  "사용자 ID",
                  "작업·대상",
                  "결과",
                  "접속 주소",
                  "사유",
                ].map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {new Date(r.occurred_at).toLocaleString("ko-KR", {
                      timeZone: "Asia/Seoul",
                    })}
                  </td>
                  <td className="mono">
                    {r.user_id?.slice(0, 8) || "비로그인"}
                  </td>
                  <td>
                    {r.action} · {r.resource_kind}
                    {!!r.resource_ids.length && (
                      <details>
                        <summary>대상 {r.resource_ids.length}건</summary>
                        <small className="break-word">
                          {r.resource_ids.join(", ")}
                        </small>
                      </details>
                    )}
                  </td>
                  <td>{r.outcome === "allowed" ? "허용" : "거부"}</td>
                  <td>
                    {r.client_address === "unknown"
                      ? "확인 불가"
                      : r.client_address}
                  </td>
                  <td>{r.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager page={page} total={data.total} onPage={setPage} />
      </section>
      <section className="panel settings-section">
        <div className="panel-heading">
          <h2>정기 점검 결과 기록</h2>
        </div>
        <form
          className="form-grid dialog-body"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              await api("/api/security", {
                method: "POST",
                body: JSON.stringify({
                  from: f.get("from"),
                  to: f.get("to"),
                  findings: f.get("findings"),
                  follow_up: f.get("follow_up"),
                }),
              });
              setMessage("접속기록 점검 결과를 저장했습니다.");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            점검 시작
            <input name="from" type="date" required />
          </label>
          <label>
            점검 종료
            <input name="to" type="date" required />
          </label>
          <label className="form-field full">
            확인 결과
            <textarea name="findings" minLength={5} maxLength={2000} required />
          </label>
          <label className="form-field full">
            후속 조치
            <textarea
              name="follow_up"
              minLength={3}
              maxLength={2000}
              required
            />
          </label>
          <button className="button">점검 결과 저장</button>
        </form>
      </section>
    </>
  );
}
