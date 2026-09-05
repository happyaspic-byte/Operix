"use client";
import { useState } from "react";
import { api, ErrorNotice } from "./ui";
import { classificationNames } from "@/lib/document-policy";
export type DocumentView = {
  id: string;
  name: string;
  classification: string;
  scan_status: string;
  version?: number;
};
export function DocumentDownload({ doc }: { doc: DocumentView }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <span className="document-download">
      <button
        className="text-link"
        disabled={busy || doc.scan_status !== "clean"}
        onClick={async () => {
          setError("");
          if (doc.classification === "internal") {
            location.assign("/api/documents/" + doc.id);
            return;
          }
          const reason = window.prompt(
            "다운로드 사유를 입력해 주세요. (5자 이상)",
          );
          if (reason === null) return;
          setBusy(true);
          try {
            const r = await api("/api/documents/" + doc.id, {
              method: "POST",
              body: JSON.stringify({ reason }),
            });
            location.assign(r.url);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {doc.name}
      </button>
      <small>
        {
          classificationNames[
            doc.classification as keyof typeof classificationNames
          ]
        }{" "}
        ·{" "}
        {doc.scan_status === "clean"
          ? "검사 완료"
          : doc.scan_status === "infected"
            ? "위험 파일 차단"
            : doc.scan_status === "error"
              ? "검사 실패 · 다운로드 차단"
              : "검사 대기"}
      </small>
      <ErrorNotice message={error} />
    </span>
  );
}
