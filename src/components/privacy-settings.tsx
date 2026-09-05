"use client";
import { catalog } from "@/lib/catalog";
import { useEffect, useState } from "react";
import { api, ErrorNotice, Loading } from "./ui";
const names: Record<string, string> = {
  customers: "고객 담당자",
  users: "임직원",
  documents: "첨부 자료",
  reports: "보고서",
  business_history: "변경 이력",
  security_logs: "접속기록",
  backups: "백업",
};
export function PrivacySettings() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<any>(null),
    [message, setMessage] = useState("");
  async function load() {
    setData(await api("/api/privacy"));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function act(body: unknown) {
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/privacy", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await load();
      return r;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <Loading />;
  return (
    <section className="panel settings-section">
      <div className="panel-heading">
        <div>
          <h2>개인정보 보유·파기 관리</h2>
          <p>
            회사에서 검토한 처리 목적·근거·예외를 등록하고 사본까지 확인합니다.
          </p>
        </div>
      </div>
      <div className="dialog-body">
        <ErrorNotice message={error} />
        {message && <p role="status">{message}</p>}
        {data.policies.map((p: any) => (
          <details key={p.resource_kind} className="policy-item">
            <summary>
              {names[p.resource_kind]} ·{" "}
              {p.approved_at ? "정책 등록됨" : "정책 검토 필요"}
            </summary>
            <form
              className="form-grid"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const r = await act({
                  action: "policy",
                  resource_kind: p.resource_kind,
                  version: p.version,
                  purpose: f.get("purpose"),
                  lawful_basis: f.get("basis"),
                  retention_days: Number(f.get("days")),
                  retention_start: f.get("start"),
                  exception_rule: f.get("exception"),
                });
                if (r)
                  setMessage(
                    "회사 보유 정책을 등록했습니다. 자동 파기는 실행되지 않습니다.",
                  );
              }}
            >
              {[
                ["purpose", "처리 목적", p.purpose],
                ["basis", "보유 근거", p.lawful_basis],
                ["days", "보유 기간 (일)", p.retention_days || ""],
                ["start", "기산 시점", p.retention_start],
                ["exception", "보존 예외", p.exception_rule],
              ].map(([key, label, value]) => (
                <label className="form-field" key={key}>
                  {label}
                  <input
                    name={key}
                    defaultValue={value}
                    type={key === "days" ? "number" : "text"}
                    min={key === "days" ? 1 : undefined}
                    max={key === "days" ? 36500 : undefined}
                    maxLength={500}
                    required
                  />
                </label>
              ))}
              <button className="button" disabled={busy}>
                검토한 정책 등록
              </button>
            </form>
          </details>
        ))}
        <h3>파기 대상 검토</h3>
        <p className="footnote">
          대상은 먼저 보관 또는 계정 정지 상태여야 합니다. 외부 문서, 자유
          입력에 남은 사본, 백업은 별도 검토가 필요합니다.
        </p>
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget),
              r = await act({
                action: "preview",
                subject_kind: f.get("kind"),
                subject_id: f.get("id"),
                reason: f.get("reason"),
                lawful_basis: f.get("basis"),
              });
            if (r) setPreview(r);
          }}
        >
          <label className="form-field">
            대상 유형
            <select name="kind">
              <option value="customers">고객</option>
              <option value="users">임직원</option>
            </select>
          </label>
          <label className="form-field">
            대상 ID
            <input name="id" required placeholder="상세 기록의 내부 식별자" />
          </label>
          <label className="form-field">
            파기 사유
            <input name="reason" required minLength={5} maxLength={500} />
          </label>
          <label className="form-field">
            파기 근거
            <input name="basis" required minLength={5} maxLength={500} />
          </label>
          <button className="button" disabled={busy}>
            파기 대상 미리보기
          </button>
        </form>
        {preview && (
          <div className="privacy-preview">
            <h3>파기 미리보기</h3>
            <dl className="detail-fields">
              {Object.entries(preview.counts).map(([k, v]) => (
                <div key={k}>
                  <dt>
                    {names[k] ||
                      catalog[k]?.title ||
                      (
                        {
                          entries: "작업 기록",
                          import_batches: "가져오기 미리보기",
                          notifications: "알림",
                          audit_logs: "변경 이력",
                        } as Record<string, string>
                      )[k] ||
                      k}
                  </dt>
                  <dd>{String(v)}건</dd>
                </div>
              ))}
            </dl>
            <p>
              등록된 백업 {preview.backup_count}건 · 원본 변경 또는 30분 경과 시
              재검토가 필요합니다.
            </p>
            <button
              className="button"
              disabled={busy}
              onClick={async () => {
                if (
                  window.prompt(
                    "원본과 첨부를 삭제합니다. 실행하려면 “파기 실행”을 입력해 주세요.",
                  ) !== "파기 실행"
                )
                  return;
                const r = await act({
                  action: "execute",
                  id: preview.id,
                  confirm: "파기 실행",
                });
                if (r) {
                  setPreview(null);
                  setMessage(
                    "원본 파기를 실행했습니다. 첨부 처리 결과와 외부 사본 확인 상태를 아래에서 확인해 주세요.",
                  );
                }
              }}
            >
              확인한 대상 파기 실행
            </button>
          </div>
        )}
        <details className="policy-item">
          <summary>보존 예외 등록</summary>
          <form
            className="form-grid"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget,
                f = new FormData(form);
              const r = await act({
                action: "hold",
                subject_kind: f.get("kind"),
                subject_id: f.get("id"),
                reason: f.get("reason"),
                authority: f.get("authority"),
              });
              if (r) form.reset();
            }}
          >
            <label>
              대상 유형
              <select name="kind">
                <option value="customers">고객</option>
                <option value="users">임직원</option>
              </select>
            </label>
            {[
              ["id", "대상 ID"],
              ["reason", "보존 사유"],
              ["authority", "보존 근거·담당 승인"],
            ].map(([key, label]) => (
              <label className="form-field" key={key}>
                {label}
                <input name={key} required maxLength={500} />
              </label>
            ))}
            <button className="button" disabled={busy}>
              보존 예외 등록
            </button>
          </form>
          {data.holds
            .filter((h: any) => h.active)
            .map((h: any) => (
              <div className="document-row" key={h.id}>
                <span>
                  {h.subject_id} · {h.reason}
                </span>
                <button
                  className="button small"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt(
                      "보존 예외 해제 근거 (5자 이상)",
                    );
                    if (reason) act({ action: "release", id: h.id, reason });
                  }}
                >
                  예외 해제
                </button>
              </div>
            ))}
        </details>
        <h3>파기 처리 이력</h3>
        {data.requests.map((r: any) => (
          <div className="document-row" key={r.id}>
            <div>
              <strong>{r.subject_id}</strong>
              <small>
                {{
                  preview: "미리보기",
                  pending_files: "첨부 삭제 대기",
                  pending_backups: "외부 사본 확인 대기",
                  completed: "운영자 확인 완료",
                }[r.state as string] || r.state}{" "}
                · {r.reason}
              </small>
            </div>
            {r.state === "pending_backups" && (
              <button
                className="button small"
                disabled={busy}
                onClick={() => {
                  const disposition = window.prompt(
                    "백업 삭제·만료, 외부 문서 및 자유 입력 사본 검토 결과와 확인 근거를 기록해 주세요. (20자 이상)",
                  );
                  if (disposition)
                    act({
                      action: "confirm_copies",
                      id: r.id,
                      disposition,
                      confirm: "외부 사본 확인 완료",
                    });
                }}
              >
                사본 처리 근거 기록
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
