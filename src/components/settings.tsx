"use client";
import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Pencil,
  X,
  RefreshCw,
  ShieldCheck,
  Users,
  Activity,
} from "lucide-react";
import { api, ErrorNotice, Loading, Badge } from "./ui";
import { OperationsSettings } from "./operations-settings";
import { PrivacySettings } from "./privacy-settings";
import { roles, roleNames } from "@/lib/policy";
export function Settings() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [editor, setEditor] = useState<any>(null),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/api/settings")
      .then(setData)
      .catch((e) => setError(e.message));
  }, [refresh]);
  if (!data) return error ? <ErrorNotice message={error} /> : <Loading />;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ADMINISTRATION</div>
          <h1>설정</h1>
          <p>임직원 계정과 업무 시스템의 운영 상태를 관리합니다.</p>
        </div>
        <button
          className="button primary"
          onClick={() =>
            setEditor({ name: "", email: "", role: "engineer", active: true })
          }
        >
          <Plus size={16} />
          임직원 계정 발급
        </button>
      </div>
      <ErrorNotice message={error} />
      <section className="panel">
        <div className="panel-heading">
          <h2>사용자와 권한</h2>
          <Users size={18} />
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>이름</th>
                <th>이메일</th>
                <th>역할</th>
                <th>상태</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u: any) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                  </td>
                  <td>{u.email}</td>
                  <td>{roleNames[u.role as keyof typeof roleNames]}</td>
                  <td>
                    <Badge
                      value={u.active ? "active" : "archived"}
                      label={u.active ? "활성" : "정지"}
                    />
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`${u.name} 수정`}
                      onClick={() => setEditor(u)}
                    >
                      <Pencil size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel settings-section">
        <div className="panel-heading">
          <div>
            <h2>점검 일정·만료 알림</h2>
            <p>반복 점검 회차와 계약 만료 알림의 생성 상태입니다.</p>
          </div>
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/jobs", { method: "POST" });
                setRefresh((n) => n + 1);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={16} />
            지금 갱신
          </button>
        </div>
        <div className="settings-content">
          <ShieldCheck size={24} />
          <div>
            <strong>최근 정상 처리</strong>
            <p>
              {data.jobs[0]?.last_success
                ? new Date(data.jobs[0].last_success).toLocaleString("ko-KR", {
                    timeZone: "Asia/Seoul",
                  })
                : "아직 처리되지 않았습니다."}
            </p>
            {data.jobs[0]?.last_error && (
              <ErrorNotice message={data.jobs[0].last_error} />
            )}
          </div>
        </div>
      </section>
      <section className="panel settings-section">
        <div className="panel-heading">
          <h2>최근 감사 기록</h2>
          <Activity size={18} />
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>사용자</th>
                <th>작업</th>
                <th>대상</th>
                <th>시간</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((h: any) => (
                <tr key={h.id}>
                  <td>{h.user_name || "시스템"}</td>
                  <td>{h.action}</td>
                  <td>{h.entity_kind}</td>
                  <td>
                    {new Date(h.created_at).toLocaleString("ko-KR", {
                      timeZone: "Asia/Seoul",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <OperationsSettings users={data.users} health={data.health} />
      <PrivacySettings />
      {editor && (
        <UserEditor
          initial={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setRefresh((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
function UserEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [data, setData] = useState({ ...initial, password: "" }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="editor-dialog compact" onCancel={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/api/settings", {
              method: "POST",
              body: JSON.stringify({
                ...(initial.id
                  ? { id: initial.id, version: initial.version }
                  : {}),
                email: data.email,
                name: data.name,
                role: data.role,
                active: data.active,
                ...(data.password ? { password: data.password } : {}),
              }),
            });
            onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <h2>{initial.id ? "임직원 계정 수정" : "임직원 계정 발급"}</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="닫기"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="dialog-body">
          <ErrorNotice message={error} />
          <div className="form-grid single">
            {[
              ["name", "이름"],
              ["email", "이메일"],
              [
                "password",
                initial.id ? "새 비밀번호 (변경 시)" : "초기 비밀번호",
              ],
            ].map(([key, label]) => (
              <div className="form-field" key={key}>
                <label htmlFor={"user-" + key}>{label}</label>
                <input
                  id={"user-" + key}
                  type={
                    key === "password"
                      ? "password"
                      : key === "email"
                        ? "email"
                        : "text"
                  }
                  minLength={key === "password" ? 12 : undefined}
                  required={key !== "password" || !initial.id}
                  value={data[key]}
                  onChange={(e) => setData({ ...data, [key]: e.target.value })}
                />
              </div>
            ))}
            <div className="form-field">
              <label htmlFor="user-role">역할</label>
              <select
                id="user-role"
                value={data.role}
                onChange={(e) => setData({ ...data, role: e.target.value })}
              >
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {roleNames[role]}
                  </option>
                ))}
              </select>
            </div>
            <label className="inline-checkbox">
              <input
                type="checkbox"
                checked={data.active}
                onChange={(e) => setData({ ...data, active: e.target.checked })}
              />
              활성 계정
            </label>
          </div>
          <p className="footnote">
            역할·비밀번호 변경 또는 정지 시 해당 사용자의 기존 로그인이
            해제됩니다.
          </p>
        </div>
        <div className="dialog-footer">
          <button className="button" type="button" onClick={onClose}>
            취소
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
