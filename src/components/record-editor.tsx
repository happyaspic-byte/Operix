"use client";
import { useEffect, useRef, useState } from "react";
import { X, Plus, Trash2, Save } from "lucide-react";
import { catalog, type Field } from "@/lib/catalog";
import { can } from "@/lib/policy";
import { api, useUser, ErrorNotice } from "./ui";
import { useModalDialog } from "./use-modal-dialog";
export function RecordEditor({
  kind,
  initial,
  onClose,
  onSaved,
}: {
  kind: string;
  initial?: Record<string, any>;
  onClose: () => void;
  onSaved: (row: any) => void;
}) {
  const user = useUser(),
    config = catalog[kind],
    dialog = useModalDialog(),
    errorSummary = useRef<HTMLDivElement>(null),
    [fieldErrors, setFieldErrors] = useState<Record<string, string>>({}),
    baseline = useRef(""),
    versionRef = useRef(initial?.version),
    [conflict, setConflict] = useState<Record<string, any> | null>(null),
    [relationSearch, setRelationSearch] = useState<Record<string, string>>({}),
    [data, setData] = useState<Record<string, any>>({}),
    [lookup, setLookup] = useState<Record<string, any[]>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const values: Record<string, any> = {};
    for (const f of config.fields) {
      let v = initial?.[f.key];
      if (v === undefined || v === null)
        v =
          f.type === "assets" || f.type === "checklist"
            ? []
            : f.type === "select"
              ? f.options?.[0][0]
              : f.type === "number"
                ? f.key === "notice_days"
                  ? 90
                  : f.min || ""
                : "";
      if (f.type === "date" && v) v = String(v).slice(0, 10);
      if (f.type === "select" && v) v = String(v);
      values[f.key] = v;
    }
    if (!initial?.id && kind === "assets" && !initial?.status)
      values.status = "unknown";
    setData(values);
    baseline.current = JSON.stringify(values);
    api(
      "/api/lookups?" +
        new URLSearchParams({
          current_kind: kind,
          current_id: initial?.id || "",
        }),
    )
      .then(setLookup)
      .catch((e) => setError(e.message));
  }, [kind, initial?.id]);
  const dirty = JSON.stringify(data) !== baseline.current;
  useEffect(() => {
    function warn(e: BeforeUnloadEvent) {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (error) errorSummary.current?.focus();
  }, [error]);
  function close() {
    if (busy) return;
    if (
      dirty &&
      !window.confirm(
        "저장하지 않은 내용이 있습니다. 변경 내용을 버리고 닫을까요?",
      )
    )
      return;
    onClose();
  }
  async function searchRelation(entity: string, value: string) {
    setRelationSearch((s) => ({ ...s, [entity]: value }));
    try {
      const next = await api(
        "/api/lookups?" +
          new URLSearchParams({
            entity,
            q: value,
            current_kind: kind,
            current_id: initial?.id || "",
          }),
      );
      setLookup((old) => ({ ...old, ...next }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function update(key: string, value: any) {
    setFieldErrors((errors) => {
      const next = { ...errors };
      for (const id of Object.keys(next)) {
        if (id === "field-" + key || id.startsWith("field-" + key + "-item-"))
          delete next[id];
      }
      return next;
    });
    setData((d) => ({
      ...d,
      [key]: value,
      ...(key === "customer_id" ? { asset_ids: [] } : {}),
    }));
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload: Record<string, any> = {};
      for (const f of config.fields)
        if (!f.permission || can(user.role, f.permission))
          payload[f.key] = data[f.key];
      if (initial?.id) payload.version = versionRef.current;
      const saved = await api(
        `/api/data/${kind}${initial?.id ? "/" + initial.id : ""}`,
        {
          method: initial?.id ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );
      onSaved(saved);
    } catch (e) {
      if ((e as Error & { status?: number }).status === 409 && initial?.id) {
        try {
          setConflict(await api(`/api/data/${kind}/${initial.id}`));
        } catch {}
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function input(f: Field) {
    const id = "field-" + f.key,
      value = data[f.key] ?? "";
    const accessibility = {
      "aria-invalid": Boolean(fieldErrors[id]),
      "aria-describedby": fieldErrors[id] ? id + "-error" : undefined,
    };
    if (f.type === "select" || f.type === "relation") {
      let choices =
        f.type === "select"
          ? f.options || []
          : (lookup[f.entity!] || []).map((r) => [
              r.id,
              (r.customer_name ? r.customer_name + " · " : "") +
                r.name +
                (r.status === "archived" ? " (보관·비활성 · 기존 연결)" : ""),
            ]);
      if (f.key === "assignee_id" && user.role === "engineer")
        choices = choices.filter((c) => c[0] === user.id);
      return (
        <>
          {f.type === "relation" && (
            <input
              aria-label={f.label + " 후보 검색"}
              placeholder="후보 검색 (최대 100건)"
              value={relationSearch[f.entity!] || ""}
              onChange={(e) => searchRelation(f.entity!, e.target.value)}
            />
          )}
          <select
            id={id}
            {...accessibility}
            value={value}
            required={f.required}
            onChange={(e) => update(f.key, e.target.value)}
          >
            {(!f.required || f.type === "relation") && (
              <option value="">선택해 주세요</option>
            )}
            {choices.map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </>
      );
    }
    if (f.type === "textarea")
      return (
        <textarea
          id={id}
          {...accessibility}
          rows={4}
          value={value}
          onChange={(e) => update(f.key, e.target.value)}
          maxLength={10000}
        />
      );
    if (f.type === "assets") {
      const candidates = (lookup.assets || []).filter(
        (a) => !data.customer_id || a.customer_id === data.customer_id,
      );
      return (
        <div
          className="checkbox-list"
          id={id}
          role="group"
          aria-labelledby={id + "-label"}
        >
          {candidates.length ? (
            candidates.map((a) => (
              <label key={a.id}>
                <input
                  type="checkbox"
                  checked={(data[f.key] || []).includes(a.id)}
                  onChange={(e) =>
                    update(
                      f.key,
                      e.target.checked
                        ? [...(data[f.key] || []), a.id]
                        : (data[f.key] || []).filter((v: string) => v !== a.id),
                    )
                  }
                />
                <span>
                  {a.name}
                  <small>{a.asset_tag || "ID 미등록"}</small>
                </span>
              </label>
            ))
          ) : (
            <span className="muted">
              고객사를 선택하고 자산을 등록해 주세요.
            </span>
          )}
        </div>
      );
    }
    if (f.type === "checklist")
      return (
        <div
          className="checklist-editor"
          role="group"
          aria-labelledby={id + "-label"}
        >
          {(data[f.key] || []).map((item: any, i: number) => (
            <div key={i}>
              <input
                type="checkbox"
                aria-label={`${item.label || "점검 항목"} 확인`}
                checked={item.checked}
                onChange={(e) =>
                  update(
                    f.key,
                    data[f.key].map((v: any, n: number) =>
                      n === i ? { ...v, checked: e.target.checked } : v,
                    ),
                  )
                }
              />
              <div className="checklist-input">
                <input
                  id={`${id}-item-${i}`}
                  aria-invalid={Boolean(fieldErrors[`${id}-item-${i}`])}
                  aria-describedby={
                    fieldErrors[`${id}-item-${i}`]
                      ? `${id}-item-${i}-error`
                      : undefined
                  }
                  aria-label={`점검 항목 ${i + 1}`}
                  value={item.label}
                  maxLength={300}
                  required
                  onChange={(e) =>
                    update(
                      f.key,
                      data[f.key].map((v: any, n: number) =>
                        n === i ? { ...v, label: e.target.value } : v,
                      ),
                    )
                  }
                />
                {fieldErrors[`${id}-item-${i}`] && (
                  <p className="field-error" id={`${id}-item-${i}-error`}>
                    {fieldErrors[`${id}-item-${i}`]}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`점검 항목 ${i + 1} 삭제`}
                onClick={() =>
                  update(
                    f.key,
                    data[f.key].filter((_: any, n: number) => n !== i),
                  )
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            className="button small"
            type="button"
            onClick={() =>
              update(f.key, [
                ...(data[f.key] || []),
                { label: "", checked: false },
              ])
            }
          >
            <Plus size={14} />
            점검 항목 추가
          </button>
        </div>
      );
    return (
      <input
        id={id}
        {...accessibility}
        type={
          f.type === "number" ? "number" : f.type === "date" ? "date" : "text"
        }
        required={f.required}
        min={f.min}
        max={f.max}
        maxLength={f.type === "text" || !f.type ? 300 : undefined}
        value={value}
        onChange={(e) => update(f.key, e.target.value)}
      />
    );
  }
  return (
    <dialog
      ref={dialog}
      className="editor-dialog"
      aria-labelledby="record-editor-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={submit}
        aria-busy={busy}
        onInvalid={(event) => {
          const field = event.target as HTMLInputElement;
          if (field.id)
            setFieldErrors((errors) => ({
              ...errors,
              [field.id]: field.validationMessage,
            }));
        }}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">
              {initial?.id ? "EDIT RECORD" : "NEW RECORD"}
            </span>
            <h2 id="record-editor-title">
              {config.singular} {initial?.id ? "수정" : "등록"}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="닫기"
            disabled={busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <div className="dialog-body">
          <p className="footnote">
            입력 중인 내용은 이 화면에만 유지됩니다. 로그인 만료 시 다른 탭에서
            다시 로그인한 뒤 저장하세요. 탭을 닫으면 입력 내용이 사라집니다.
          </p>
          <div ref={errorSummary} tabIndex={-1}>
            <ErrorNotice message={error} />
          </div>
          {conflict && (
            <div className="privacy-preview">
              <h3>다른 사용자의 수정과 비교</h3>
              <p>
                필요한 값을 입력란에 반영한 뒤 최신 버전으로 다시 저장하세요.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>항목</th>
                      <th>서버의 현재 값</th>
                      <th>내 입력</th>
                      <th>선택</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.fields
                      .filter(
                        (f) => !f.permission || can(user.role, f.permission),
                      )
                      .filter(
                        (f) =>
                          JSON.stringify(conflict[f.key]) !==
                          JSON.stringify(data[f.key]),
                      )
                      .map((f) => (
                        <tr key={f.key}>
                          <td>{f.label}</td>
                          <td>{JSON.stringify(conflict[f.key])}</td>
                          <td>{JSON.stringify(data[f.key])}</td>
                          <td>
                            <button
                              type="button"
                              className="button small"
                              onClick={() =>
                                update(
                                  f.key,
                                  f.type === "select"
                                    ? String(conflict[f.key])
                                    : (conflict[f.key] ?? ""),
                                )
                              }
                            >
                              서버 값 사용
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => {
                  versionRef.current = conflict.version;
                  setConflict(null);
                  setError("차이를 검토했습니다. 저장 버튼으로 반영해 주세요.");
                }}
              >
                현재 입력으로 검토 완료
              </button>
            </div>
          )}

          <div className="form-grid">
            {config.fields
              .filter((f) => !f.permission || can(user.role, f.permission))
              .map((f) => (
                <div
                  className={`form-field ${["textarea", "assets", "checklist"].includes(f.type || "") ? "full" : ""}`}
                  key={f.key}
                >
                  <label
                    id={"field-" + f.key + "-label"}
                    htmlFor={
                      ["assets", "checklist"].includes(f.type || "")
                        ? undefined
                        : "field-" + f.key
                    }
                  >
                    {f.label}
                    {f.required && <span className="required">*</span>}
                  </label>
                  {input(f)}
                  {fieldErrors["field-" + f.key] && (
                    <p className="field-error" id={"field-" + f.key + "-error"}>
                      {fieldErrors["field-" + f.key]}
                    </p>
                  )}
                </div>
              ))}
          </div>
        </div>
        <div className="dialog-footer">
          <span>
            필수 항목 <span className="required">*</span>
          </span>
          <div>
            <button
              type="button"
              className="button"
              onClick={close}
              disabled={busy}
            >
              취소
            </button>
            <button className="button primary" disabled={busy}>
              <Save size={16} />
              {busy ? "저장 중…" : "저장"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
