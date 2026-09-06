"use client";
import { useState } from "react";
import { useModalDialog } from "./use-modal-dialog";
import { X, Upload, Download, Check } from "lucide-react";
import { api, ErrorNotice } from "./ui";
export function ImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const dialog = useModalDialog(),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [mapping, setMapping] = useState<Record<string, string>>({});
  async function check() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("mapping", JSON.stringify(mapping));
      setPreview(await api("/api/import", { method: "POST", body: form }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    setBusy(true);
    setError("");
    try {
      await api("/api/import", {
        method: "PATCH",
        body: JSON.stringify({ batch_id: preview.batch_id }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      className="editor-dialog"
      ref={dialog}
      aria-labelledby="import-dialog-title"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id="import-dialog-title">엑셀에서 자산 가져오기</h2>
        <button
          className="icon-button"
          aria-label="닫기"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="dialog-body">
        <p className="muted">
          표준 양식을 사용하거나 열을 연결한 뒤, 변경 내용을 확인하고
          반영하세요. 최대 1,000행 · 5MB.
        </p>
        <a className="button small" href="/api/import">
          <Download size={15} />
          표준 양식 내려받기
        </a>
        <label className="file-drop">
          XLSX / CSV 파일 선택
          <input
            type="file"
            accept=".xlsx,.csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setPreview(null);
            }}
          />
        </label>
        <ErrorNotice message={error} />
        {preview && (
          <>
            <div className="import-mapping">
              {[
                ["site_id", "사업장 ID"],
                ["name", "자산명"],
                ["asset_tag", "자산 ID"],
                ["product", "제품"],
                ["model", "모델"],
                ["software_version", "소프트웨어 버전"],
                ["protection", "보호 모드"],
                ["status", "확인 상태"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <select
                    value={mapping[key] || label}
                    onChange={(e) => {
                      setMapping({ ...mapping, [key]: e.target.value });
                      setPreview({ ...preview, valid: false });
                    }}
                  >
                    <option value={label}>{label}</option>
                    {preview.headers
                      .filter((h: string) => h !== label)
                      .map((h: string) => (
                        <option key={h}>{h}</option>
                      ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="import-summary">
              검토 대상 {preview.rows.length}행 · 오류{" "}
              {preview.rows.filter((r: any) => r.action === "error").length}행
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>행</th>
                    <th>자산</th>
                    <th>작업</th>
                    <th>검증 결과</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row: any) => (
                    <tr key={row.row}>
                      <td>{row.row}</td>
                      <td>{row.name}</td>
                      <td>
                        {row.action === "create"
                          ? "신규"
                          : row.action === "update"
                            ? "수정"
                            : "오류"}
                      </td>
                      <td>{row.error || row.site_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div className="dialog-footer">
        <button className="button" disabled={busy} onClick={onClose}>
          취소
        </button>
        <div>
          <button className="button" disabled={!file || busy} onClick={check}>
            <Upload size={15} />
            미리보기 검증
          </button>
          <button
            className="button primary"
            disabled={!preview?.valid || busy}
            onClick={commit}
          >
            <Check size={15} />
            {busy ? "처리 중…" : "확인한 내용 반영"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
