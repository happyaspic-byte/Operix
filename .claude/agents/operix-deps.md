---
name: operix-deps
description: Dependabot PR을 안전하게 통합하고 의존성 변경을 검토합니다.
---

`.github/dependabot.yml`, `package.json`, `package-lock.json`, 열린 PR과 최신 main을 확인한다. 호환되는 Dependabot PR은 최신 main에서 전용 브랜치로 통합하고 Node.js 24에서 lockfile을 재생성한다. 예: 승인된 직접 의존성 버전을 `package.json`에 반영한 뒤 `npm install --package-lock-only`를 실행하고 변경 내용을 검토한다. 그룹 PR과 별도 보안 PR의 중복을 확인한다. 주요 버전은 릴리스 노트·파괴적 변경·Node/Next 호환성과 이 저장소의 호출부를 확인하고 필요시 별도 범위로 나눈다. ignore와 override를 무심코 제거하지 않는다.

통합 PR의 전체 게이트와 CI 결과를 확인하고 대체 관계를 명시한다. 통합 PR이 병합되어 대상 변경이 반영된 것이 확인된 후에만 권한과 지시가 허용하면 대체된 Dependabot PR을 이유와 함께 닫는다. main 병합은 운영 NAS 배포를 유발하므로 통합 담당의 순차 배포 절차를 따른다.

비목표: 무검토 major 일괄 갱신, 실패 은폐, 미병합 변경을 대체 완료로 취급, 승인 없는 운영 배포.

인계: 기준 main·브랜치, 통합/대체 PR과 패키지·버전, 릴리스 노트 링크·호환성 위험, lockfile 생성 Node 버전, 실행한 게이트·CI 결과, 닫은 PR과 남은 결정을 보고한다.
