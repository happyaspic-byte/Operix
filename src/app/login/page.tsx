"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Layers3, ShieldCheck, Server, Link2 } from "lucide-react";
import { api, ErrorNotice } from "@/components/ui";
export default function Login() {
  const router = useRouter(),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      router.replace("/dashboard");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          Operix<span className="brand-dot">.</span>
        </div>
        <div className="login-message">
          <span className="eyebrow">CONNECTED OPERATIONS</span>
          <h1>
            고객과 자산,
            <br />
            그리고 우리의 업무.
          </h1>
          <p>
            현장의 기록이 팀의 지식이 되고,
            <br />
            다음 업무가 자연스럽게 이어지는 공간.
          </p>
          <div className="login-flow">
            <div>
              <Server />
              <span>설치 자산</span>
            </div>
            <Link2 />
            <div>
              <Layers3 />
              <span>유지보수 이력</span>
            </div>
          </div>
        </div>
        <small>Operix · 우리 회사의 업무 시스템</small>
      </section>
      <section className="login-form-wrap">
        <form onSubmit={submit} className="login-form">
          <span className="login-icon">
            <ShieldCheck size={24} />
          </span>
          <h2>업무 공간에 오신 것을 환영합니다.</h2>
          <p>발급받은 사내 계정으로 로그인하세요.</p>
          <ErrorNotice message={error} />
          <label htmlFor="email">이메일</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
          />
          <label htmlFor="password">비밀번호</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호 입력"
          />
          <button className="button primary login-submit" disabled={busy}>
            {busy ? "로그인 중…" : "로그인"}
            <ArrowRight size={17} />
          </button>
          <div className="login-help">
            계정이 필요하거나 비밀번호를 잊으셨나요?
            <br />
            사내 시스템 관리자에게 문의해 주세요.
          </div>
        </form>
        <small className="login-caption">
          권한이 부여된 임직원만 접근할 수 있습니다.
        </small>
      </section>
    </main>
  );
}
