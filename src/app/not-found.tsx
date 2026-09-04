import Link from "next/link";
export default function NotFound() {
  return (
    <main className="empty-state">
      <h1>페이지를 찾을 수 없습니다.</h1>
      <p>주소가 변경되었거나 삭제된 자료입니다.</p>
      <Link className="button primary" href="/dashboard">
        대시보드로 이동
      </Link>
    </main>
  );
}
