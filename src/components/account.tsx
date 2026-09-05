"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ErrorNotice, Loading } from "./ui";
export function Account() {
  const router = useRouter(),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setData(await api("/api/account"));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  if (!data) return error ? <ErrorNotice message={error} /> : <Loading />;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>내 계정</h1>
          <p>비밀번호와 로그인한 기기를 관리합니다.</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      {message && <p role="status">{message}</p>}
      {data.user.must_change_password && (
        <p className="error-notice">
          초기 비밀번호를 변경한 뒤 업무를 시작해 주세요.
        </p>
      )}
      <section className="panel settings-section">
        <div className="panel-heading">
          <h2>비밀번호 변경</h2>
        </div>
        <form
          className="dialog-body form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget,
              f = new FormData(form);
            if (f.get("password") !== f.get("confirm")) {
              setError("새 비밀번호 확인이 일치하지 않습니다.");
              return;
            }
            setBusy(true);
            setError("");
            try {
              await api("/api/account", {
                method: "POST",
                body: JSON.stringify({
                  action: "password",
                  current_password: f.get("current"),
                  password: f.get("password"),
                }),
              });
              form.reset();
              setMessage(
                "비밀번호를 변경하고 다른 기기의 로그인을 해제했습니다.",
              );
              await load();
              router.refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {[
            ["current", "현재 비밀번호"],
            ["password", "새 비밀번호"],
            ["confirm", "새 비밀번호 확인"],
          ].map(([key, label]) => (
            <label className="form-field" key={key}>
              {label}
              <input
                type="password"
                name={key}
                minLength={key === "current" ? 1 : 12}
                maxLength={256}
                autoComplete={
                  key === "current" ? "current-password" : "new-password"
                }
                required
              />
            </label>
          ))}
          <div>
            <button className="button primary" disabled={busy}>
              비밀번호 변경
            </button>
          </div>
        </form>
      </section>
      <section className="panel settings-section">
        <div className="panel-heading">
          <h2>로그인한 기기</h2>
        </div>
        <div className="document-list">
          {data.sessions.map((s: any) => (
            <div className="document-row" key={s.id}>
              <div>
                <strong>
                  {s.id === data.user.session_id ? "현재 기기" : "다른 기기"} ·{" "}
                  {s.client_address}
                </strong>
                <small>
                  {s.user_agent || "기기 정보 없음"} · 최근 사용{" "}
                  {new Date(s.last_seen_at).toLocaleString("ko-KR", {
                    timeZone: "Asia/Seoul",
                  })}
                </small>
              </div>
              <button
                className="button small"
                onClick={async () => {
                  try {
                    await api("/api/account", {
                      method: "POST",
                      body: JSON.stringify({
                        action: "revoke",
                        session_id: s.id,
                      }),
                    });
                    if (s.id === data.user.session_id)
                      location.assign("/login");
                    else await load();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                로그인 해제
              </button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
