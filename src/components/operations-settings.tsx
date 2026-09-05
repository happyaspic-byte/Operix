"use client";
import { useEffect, useState } from "react";
import { api, ErrorNotice } from "./ui";
import { labels, catalog } from "@/lib/catalog";
export function OperationsSettings({
  users,
  health,
}: {
  users: any[];
  health: any;
}) {
  const [policies, setPolicies] = useState<any[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () => api("/api/workflow").then(setPolicies);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <section className="panel settings-section">
        <div className="panel-heading">
          <h2>운영 상태</h2>
        </div>
        <dl className="detail-fields">
          <div>
            <dt>작업자</dt>
            <dd>{health?.worker?.ok ? "정상" : "처리 지연 또는 중단"}</dd>
          </div>
          <div>
            <dt>저장 여유 공간</dt>
            <dd>
              {Math.round((health?.storage_free_bytes || 0) / 1024 / 1024)} MB
            </dd>
          </div>
          <div>
            <dt>백업</dt>
            <dd>
              {health?.backup?.required
                ? health.backup.ok
                  ? "정상"
                  : "지연 또는 미확인"
                : "감시 미설정"}
            </dd>
          </div>
          <div>
            <dt>DB 연결 대기</dt>
            <dd>{health?.pool?.waiting || 0}건</dd>
          </div>
        </dl>
      </section>
      <section className="panel settings-section">
        <div className="panel-heading">
          <h2>담당 업무 인계</h2>
        </div>
        <form
          className="dialog-body form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (
              !window.confirm(
                "미완료 업무와 관리 중인 자산·계약을 새 담당자에게 인계할까요?",
              )
            )
              return;
            setBusy(true);
            try {
              const r = await api("/api/account", {
                method: "POST",
                body: JSON.stringify({
                  action: "handoff",
                  from: f.get("from"),
                  to: f.get("to"),
                }),
              });
              setMessage(
                "인계 완료: " +
                  Object.entries(r)
                    .map(([k, v]) => (catalog[k]?.title || k) + " " + v + "건")
                    .join(", "),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="form-field">
            기존 담당자
            <select name="from" required>
              <option value="">선택</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.active ? "" : " (정지)"}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            새 담당자
            <select name="to" required>
              <option value="">선택</option>
              {users
                .filter(
                  (u) =>
                    u.active &&
                    ["admin", "manager", "engineer"].includes(u.role),
                )
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </label>
          <button className="button" disabled={busy}>
            미완료 업무 인계
          </button>
        </form>
      </section>
      <section className="panel settings-section">
        <div className="panel-heading">
          <div>
            <h2>응답·해결 목표 시간</h2>
            <p>
              새 접수 건에 적용합니다. 24시간 경과 시간 기준이며 대기 상태도
              포함합니다.
            </p>
          </div>
        </div>
        <div className="dialog-body">
          <ErrorNotice message={error} />
          {message && <p role="status">{message}</p>}
          {policies.map((p) => (
            <form
              key={p.severity}
              className="form-grid policy-item"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                const f = new FormData(e.currentTarget);
                try {
                  await api("/api/workflow", {
                    method: "POST",
                    body: JSON.stringify({
                      action: "sla_policy",
                      severity: p.severity,
                      version: p.version,
                      enabled: f.has("enabled"),
                      response_minutes: Number(f.get("response")),
                      resolution_minutes: Number(f.get("resolution")),
                    }),
                  });
                  await load();
                  setMessage(
                    "SLA 정책을 저장했습니다. 기존 업무의 목표 시간은 보존됩니다.",
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label className="inline-checkbox">
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={p.enabled}
                />
                {labels[p.severity]} SLA 사용
              </label>
              <label className="form-field">
                응답 목표 (분)
                <input
                  name="response"
                  type="number"
                  min={1}
                  max={525600}
                  defaultValue={p.response_minutes || ""}
                  required
                />
              </label>
              <label className="form-field">
                해결 목표 (분)
                <input
                  name="resolution"
                  type="number"
                  min={1}
                  max={525600}
                  defaultValue={p.resolution_minutes || ""}
                  required
                />
              </label>
              <button className="button" disabled={busy}>
                정책 저장
              </button>
            </form>
          ))}
        </div>
      </section>
    </>
  );
}
