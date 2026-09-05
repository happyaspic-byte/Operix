"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Building2,
  Server,
  Files,
  CalendarDays,
  LifeBuoy,
  Settings2,
  Search,
  Bell,
  LogOut,
  Menu,
  X,
  ArrowUpRight,
} from "lucide-react";
import type { User } from "@/lib/auth";
import { catalog } from "@/lib/catalog";
import { roleNames } from "@/lib/policy";
import { UserContext, api } from "./ui";
const nav = [
  { href: "dashboard", label: "대시보드", icon: LayoutDashboard },
  { href: "customers", label: "고객·사업장", icon: Building2 },
  { href: "assets", label: "자산 관리", icon: Server },
  { href: "contracts", label: "계약·지원", icon: Files },
  { href: "inspections", label: "점검·일정", icon: CalendarDays },
  { href: "tickets", label: "장애·작업", icon: LifeBuoy },
  { href: "documents", label: "문서·보고서", icon: Files },
];
export function Shell({
  user,
  children,
}: {
  user: User;
  children: React.ReactNode;
}) {
  const pathname = usePathname(),
    router = useRouter();
  const [menu, setMenu] = useState(false),
    [q, setQ] = useState(""),
    [results, setResults] = useState<any[]>([]),
    [notifications, setNotifications] = useState<any[]>([]),
    [unreadTotal, setUnreadTotal] = useState(0),
    [panel, setPanel] = useState(false),
    [searchError, setSearchError] = useState("");
  const current =
    nav.find((n) => pathname.startsWith("/" + n.href))?.label ||
    (pathname.startsWith("/settings")
      ? "설정"
      : pathname.startsWith("/reports")
        ? "문서·보고서"
        : "업무 공간");
  useEffect(() => {
    setMenu(false);
    setQ("");
    setPanel(false);
  }, [pathname]);
  useEffect(() => {
    if (user.must_change_password) return;
    let live = true;
    const refresh = () => {
      if (document.visibilityState === "visible")
        api("/api/notifications", { headers: { "X-Operix-Background": "1" } })
          .then((d) => {
            if (live) {
              setNotifications(d.rows);
              setUnreadTotal(d.unread_total);
            }
          })
          .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pathname, user.must_change_password]);
  useEffect(() => {
    if (user.must_change_password && pathname !== "/account")
      router.replace("/account");
  }, [pathname, user.must_change_password, router]);
  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api("/api/search?q=" + encodeURIComponent(q), {
        signal: controller.signal,
      })
        .then((d) => {
          setResults(d);
          setSearchError("");
        })
        .catch((e) => {
          if (e.name !== "AbortError") setSearchError("검색에 실패했습니다.");
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);
  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }
  return (
    <UserContext.Provider value={user}>
      <a href="#main-content" className="skip-link">
        본문으로 이동
      </a>
      <div className="app-shell">
        {menu && (
          <button
            className="sidebar-backdrop"
            aria-label="메뉴 닫기"
            onClick={() => setMenu(false)}
          />
        )}
        <aside className={`sidebar ${menu ? "is-open" : ""}`}>
          <Link
            href="/dashboard"
            className="brand"
            aria-label="Operix 대시보드"
          >
            <span className="brand-mark">
              <i />
              <i />
              <i />
              <i />
            </span>
            Operix<span className="brand-dot">.</span>
          </Link>
          <div className="workspace-chip">
            <span className="workspace-avatar">O</span>
            <div>
              <strong>우리 회사</strong>
              <small>내부 업무 공간</small>
            </div>
          </div>
          <div className="nav-label">WORKSPACE</div>
          <nav aria-label="주 메뉴">
            {nav.map((n) => (
              <Link
                key={n.href}
                className={`nav-item ${pathname.startsWith("/" + n.href) ? "active" : ""}`}
                href={"/" + n.href}
              >
                <n.icon size={19} strokeWidth={1.8} />
                <span>{n.label}</span>
                {pathname.startsWith("/" + n.href) && (
                  <span className="nav-active-dot" />
                )}
              </Link>
            ))}
          </nav>
          <div className="sidebar-footer">
            <Link className="nav-item" href="/notifications">
              <Bell size={19} />
              <span>알림 전체 보기</span>
            </Link>
            {["admin", "manager"].includes(user.role) && (
              <Link className="nav-item" href="/security">
                <Files size={19} />
                <span>접속기록 점검</span>
              </Link>
            )}
            <Link className="nav-item" href="/account">
              <Settings2 size={19} />
              <span>내 계정</span>
            </Link>
            <div className="workspace-health">
              <span className="status-dot" />
              <span>고객과 업무를 연결하는 공간</span>
            </div>
            {user.role === "admin" && (
              <Link
                className={`nav-item ${pathname === "/settings" ? "active" : ""}`}
                href="/settings"
              >
                <Settings2 size={19} />
                <span>설정</span>
              </Link>
            )}
            <div className="profile">
              <span className="avatar">{user.name.slice(0, 1)}</span>
              <div>
                <strong>{user.name}</strong>
                <small>{roleNames[user.role]}</small>
              </div>
              <button
                className="icon-button"
                aria-label="로그아웃"
                onClick={logout}
              >
                <LogOut size={17} />
              </button>
            </div>
          </div>
        </aside>
        <div className="main-wrap">
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label="메뉴 열기"
                onClick={() => setMenu(true)}
              >
                <Menu size={20} />
              </button>
              <span>Workspace</span>
              <b>/</b>
              <strong>{current}</strong>
            </div>
            <div className="topbar-actions">
              <div className="global-search">
                <Search size={16} />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="고객, 자산, 업무 검색"
                  aria-label="전체 검색"
                />
                {q && (
                  <button
                    className="icon-button"
                    aria-label="검색 지우기"
                    onClick={() => setQ("")}
                  >
                    <X size={14} />
                  </button>
                )}
                {q.trim() && (
                  <div className="search-popover">
                    {searchError ? (
                      <p>{searchError}</p>
                    ) : results.length ? (
                      results.map((row, i) => (
                        <Link
                          key={row.kind + row.id + i}
                          href={`/${row.kind}/${row.id}`}
                        >
                          <span>
                            <small>{catalog[row.kind]?.singular}</small>
                            <strong>{row.name}</strong>
                          </span>
                          <ArrowUpRight size={15} />
                        </Link>
                      ))
                    ) : (
                      <p>일치하는 자료가 없습니다.</p>
                    )}
                  </div>
                )}
              </div>
              <span className="topbar-divider" />
              <div className="notification-wrap">
                <button
                  className={`icon-button ${unreadTotal > 0 ? "has-unread" : ""}`}
                  aria-label="알림"
                  aria-expanded={panel}
                  onClick={() => setPanel(!panel)}
                >
                  <Bell size={19} />
                </button>
                {panel && (
                  <div className="notification-panel">
                    <div className="panel-heading">
                      <strong>업무 알림</strong>
                      <button
                        onClick={async () => {
                          await api("/api/notifications", { method: "PATCH" });
                          setUnreadTotal(0);
                          setNotifications(
                            notifications.map((n) => ({
                              ...n,
                              read_at: new Date().toISOString(),
                            })),
                          );
                        }}
                      >
                        모두 읽음
                      </button>
                    </div>
                    {notifications.length ? (
                      notifications.map((n) => (
                        <Link
                          className={n.read_at ? "" : "unread"}
                          href={n.href}
                          key={n.id}
                        >
                          <strong>{n.title}</strong>
                          <small>{n.body}</small>
                        </Link>
                      ))
                    ) : (
                      <p className="muted">새로운 알림이 없습니다.</p>
                    )}
                  </div>
                )}
              </div>
              <span className="top-avatar">{user.name.slice(0, 1)}</span>
            </div>
          </header>
          <main id="main-content" className="main-content">
            {children}
          </main>
          <footer className="app-footer">
            <span>Operix · Connected operations</span>
            <span>기본 시간대: 한국시간</span>
          </footer>
        </div>
      </div>
    </UserContext.Provider>
  );
}
