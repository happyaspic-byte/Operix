"use client";
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <div className="empty-state">
      <h1>정보를 불러오지 못했습니다.</h1>
      <p>연결 상태를 확인한 뒤 다시 시도해 주세요.</p>
      <button className="button primary" onClick={() => retry()}>
        다시 시도
      </button>
    </div>
  );
}
