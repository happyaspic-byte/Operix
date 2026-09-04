"use client";
import { useEffect, useRef, useState } from "react";
import { X, Plus, Trash2, Save } from "lucide-react";
import { catalog, type Field } from "@/lib/catalog";
import { can } from "@/lib/policy";
import { api, useUser, ErrorNotice } from "./ui";
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
    dialog = useRef<HTMLDialogElement>(null),
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
                ? f.min || ""
                : "";
      if (f.type === "date" && v) v = String(v).slice(0, 10);
      if (f.type === "select" && v) v = String(v);
      values[f.key] = v;
    }
    if (!initial?.id && kind === "assets" && !initial?.status)
      values.status = "unknown";
    setData(values);
    api("/api/lookups")
      .then(setLookup)
      .catch((e) => setError(e.message));
    dialog.current?.showModal();
  }, [kind, initial?.id]);
  function update(key: string, value: any) {
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
      if (initial?.id) payload.version = initial.version;
      const saved = await api(
        `/api/data/${kind}${initial?.id ? "/" + initial.id : ""}`,
        {
          method: initial?.id ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function input(f: Field) {
    const id = "field-" + f.key,
      value = data[f.key] ?? "";
    if (f.type === "select" || f.type === "relation") {
      let choices =
        f.type === "select"
          ? f.options || []
          : (lookup[f.entity!] || []).map((r) => [
              r.id,
              (r.customer_name ? r.customer_name + " · " : "") + r.name,
            ]);
      if (f.key === "assignee_id" && user.role === "engineer")
        choices = choices.filter((c) => c[0] === user.id);
      return (
        <select
          id={id}
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
      );
    }
    if (f.type === "textarea")
      return (
        <textarea
          id={id}
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
        <div className="checkbox-list" id={id}>
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
        <div className="checklist-editor">
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
              <input
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
      onCancel={onClose}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">
              {initial?.id ? "EDIT RECORD" : "NEW RECORD"}
            </span>
            <h2>
              {config.singular} {initial?.id ? "수정" : "등록"}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="닫기"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="dialog-body">
          <ErrorNotice message={error} />
          <div className="form-grid">
            {config.fields
              .filter((f) => !f.permission || can(user.role, f.permission))
              .map((f) => (
                <div
                  className={`form-field ${["textarea", "assets", "checklist"].includes(f.type || "") ? "full" : ""}`}
                  key={f.key}
                >
                  <label htmlFor={"field-" + f.key}>
                    {f.label}
                    {f.required && <span className="required">*</span>}
                  </label>
                  {input(f)}
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
              onClick={onClose}
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
