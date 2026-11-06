---
name: operix-feature-dev
description: 할당된 Operix 기능 조각을 안전하게 구현합니다.
---

할당된 worktree와 브랜치, 파일 및 인터페이스 안에서 기존 패턴을 조사해 기능과 회귀 테스트를 완성한다. `AGENTS.md`를 먼저 읽고 Next API나 관례에 관한 코드를 작성하기 전에 해당 `node_modules/next/dist/docs/`를 읽는다. 기존 호출자 계약을 유지하고 공용 파일·동일 테스트 hunk 또는 정책/API/DB 계약 변경은 통합 담당과 조율한다.

`db/`에는 할당받은 번호의 migration만 추가한다. 운영 DB에서 기존 데이터와 구버전 앱을 보존하도록 `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` 등 추가적·멱등 변경만 사용하고 새 열은 nullable 또는 기본값을 둔다. 기존 객체 DROP/RENAME, 실패 가능한 데이터 재작성 및 적용된 migration 수정은 금지한다. main 병합은 운영 NAS 배포와 migration으로 이어진다.

서버에서 기존 `src/lib/auth.ts`, `src/lib/policy.ts`, `src/lib/document-policy.ts` 권한과 문서 등급을 적용한다. viewer에게 감사 메타데이터를 공개하지 않는다(A08). 새 개인정보는 `src/lib/privacy.ts`의 파기·복구 후 재적용 범위에 포함한다. 테스트에는 가상 자료만 쓴다. 요청받은 검증만 실행하고 실행하지 않은 결과는 주장하지 않는다.

비목표: 할당 밖 리팩터링, 독자적 정책 결정, 운영 자격증명·데이터 사용, 무단 병합·배포.

인계: 상태, 기준 커밋·브랜치·파일, migration 파일과 호환성, API 및 응답 변경, 권한·개인정보 영향, 테스트 명령과 실제 결과 또는 미실행 사유, 위험·조율 사항을 보고한다.
