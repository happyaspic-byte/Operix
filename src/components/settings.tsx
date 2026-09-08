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
  Trash2,
  RotateCcw,
} from "lucide-react";
import { api, ErrorNotice, Loading, Badge, useUser } from "./ui";
import { useModalDialog } from "./use-modal-dialog";
import { OperationsSettings } from "./operations-settings";
import { PrivacySettings } from "./privacy-settings";
import { roles, roleNames } from "@/lib/policy";
export function Settings() {
  const user = useUser(),
    trashToggle = useRef<HTMLButtonElement>(null),
    focusAfterDeletion = useRef(false),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [trash, setTrash] = useState(false),
    [loadingUsers, setLoadingUsers] = useState(true),
    [editor, setEditor] = useState<any>(null),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy && focusAfterDeletion.current) {
      trashToggle.current?.focus();
      focusAfterDeletion.current = false;
    }
  }, [busy]);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingUsers(true);
    api("/api/settings" + (trash ? "?trash=1" : ""), {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setData(next);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setData((current: any) =>
            current ? { ...current, users: [] } : null,
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingUsers(false);
      });
    return () => controller.abort();
  }, [refresh, trash]);
  async function changeDeletion(account: any) {
    const restoring = Boolean(account.deleted_at);
    if (
      !restoring &&
      !window.confirm(
        `‘${account.name}’ 계정을 삭제해 휴지통으로 이동할까요? 기존 로그인은 해제되며 업무 이력은 보존됩니다. 휴지통에서 복원할 수 있고, 복원 후에도 정지 상태가 유지됩니다.`,
      )
    )
      return;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await api("/api/settings", {
        method: restoring ? "PATCH" : "DELETE",
        body: JSON.stringify({ id: account.id, version: account.version }),
      });
      focusAfterDeletion.current = true;
      setLoadingUsers(true);
      setRefresh((n) => n + 1);
      setMessage(
        restoring
          ? "계정을 복원했습니다. 로그인하려면 계정을 수정해 활성화해 주세요."
          : "계정을 휴지통으로 이동했습니다. 기존 업무 이력은 보존됩니다.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
      {message && <p role="status">{message}</p>}
      <section className="panel" aria-labelledby="users-heading">
        <div className="panel-heading">
          <h2 id="users-heading">
            <Users size={18} /> 사용자와 권한
          </h2>
          <button
            ref={trashToggle}
            className="button small trash-toggle"
            aria-pressed={trash}
            disabled={busy}
            onClick={() => {
              setTrash((current) => !current);
              setLoadingUsers(true);
              setError("");
              setMessage("");
            }}
          >
            <Trash2 size={15} />
            휴지통
          </button>
        </div>
        {trash && (
          <p className="trash-list-notice">
            삭제한 계정입니다. 복원 후에도 정지 상태가 유지되며, 계정을 수정해
            활성화할 수 있습니다.
          </p>
        )}
        <div
          className="table-scroll"
          role="region"
          aria-label="계정 목록 · 가로 스크롤 가능"
          tabIndex={0}
          aria-busy={loadingUsers}
        >
          <table>
            <thead>
              <tr>
                <th>이름</th>
                <th>이메일</th>
                <th>부서</th>
                <th>직책</th>
                <th>권한 역할</th>
                <th>상태</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {loadingUsers ? (
                <tr>
                  <td colSpan={7}>
                    <Loading />
                  </td>
                </tr>
              ) : data.users.length ? (
                data.users.map((u: any) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.name}</strong>
                    </td>
                    <td>{u.email}</td>
                    <td>{u.department || "—"}</td>
                    <td>{u.job_title || "—"}</td>
                    <td>{roleNames[u.role as keyof typeof roleNames]}</td>
                    <td>
                      <Badge
                        value={u.active ? "active" : "archived"}
                        label={
                          u.privacy_erased_at
                            ? "파기"
                            : u.deleted_at
                              ? "휴지통"
                              : u.active
                                ? "활성"
                                : "정지"
                        }
                      />
                    </td>
                    <td>
                      {u.privacy_erased_at ? (
                        <span className="muted">
                          개인정보 파기 완료 · 복구 불가
                        </span>
                      ) : (
                        <div className="heading-actions">
                          {!u.deleted_at && (
                            <button
                              className="icon-button"
                              aria-label={`${u.name} 수정`}
                              disabled={busy}
                              onClick={() => setEditor(u)}
                            >
                              <Pencil size={16} />
                            </button>
                          )}
                          {u.id !== user.id && (
                            <button
                              className={
                                "button small " + (u.deleted_at ? "" : "danger")
                              }
                              aria-label={`${u.name} ${u.deleted_at ? "복원" : "삭제"}`}
                              disabled={busy}
                              onClick={() => changeDeletion(u)}
                            >
                              {u.deleted_at ? (
                                <RotateCcw size={14} />
                              ) : (
                                <Trash2 size={14} />
                              )}
                              {u.deleted_at ? "복원" : "삭제"}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="muted">
                    {trash
                      ? "휴지통에 계정이 없습니다."
                      : "등록된 계정이 없습니다."}
                  </td>
                </tr>
              )}
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
      <OperationsSettings
        users={data.assignment_users || []}
        health={data.health}
      />
      <PrivacySettings />
      {editor && (
        <UserEditor
          initial={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setTrash(false);
            setLoadingUsers(true);
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
  const dialog = useModalDialog(),
    errorSummary = useRef<HTMLDivElement>(null),
    [data, setData] = useState({
      ...initial,
      department: initial.department || "",
      job_title: initial.job_title || "",
      password: "",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (error) errorSummary.current?.focus();
  }, [error]);
  return (
    <dialog
      ref={dialog}
      className="editor-dialog compact"
      onCancel={onClose}
      aria-labelledby="user-editor-title"
    >
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
                department: data.department,
                job_title: data.job_title,
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
          <h2 id="user-editor-title">
            {initial.id ? "임직원 계정 수정" : "임직원 계정 발급"}
          </h2>
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
          <div ref={errorSummary} tabIndex={-1}>
            <ErrorNotice message={error} />
          </div>
          <div className="form-grid single">
            {[
              ["name", "이름"],
              ["email", "이메일"],
              ["department", "부서 (선택)"],
              ["job_title", "직책 (선택)"],
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
                  required={
                    ["name", "email"].includes(key) ||
                    (key === "password" && !initial.id)
                  }
                  maxLength={
                    key === "email" ? 254 : key === "password" ? 256 : 100
                  }
                  aria-describedby={
                    ["department", "job_title"].includes(key)
                      ? "user-organization-help"
                      : undefined
                  }
                  value={data[key]}
                  onChange={(e) => setData({ ...data, [key]: e.target.value })}
                />
              </div>
            ))}
            <div className="form-field">
              <label htmlFor="user-role">권한 역할</label>
              <select
                id="user-role"
                aria-describedby="user-organization-help"
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
            <p className="footnote" id="user-organization-help">
              부서와 직책은 조직 정보이며, 시스템 접근 권한은 역할로 정합니다.
            </p>
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
