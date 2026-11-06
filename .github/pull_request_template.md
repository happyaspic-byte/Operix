## 요약

- 변경 내용과 업무상 이유:
- 관련 이슈:

## Migration

- 변경 여부: Y / N
- 파일명 및 운영·구버전 호환성:
- [ ] 해당 시 추가적·멱등 SQL, nullable/default 열, 기존 객체·데이터 보존을 확인했습니다.
- [ ] 해당 없음

## 권한·개인정보 영향

- 역할별 서버 권한, 문서 등급, viewer 감사 메타데이터(A08):
- 개인정보 수집·파기 및 복구 후 재적용 영향:

## 검증

- 기준 커밋 / Node 24 / 격리 환경:
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check` (별도 게이트)
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npx playwright install chromium` 및 `FILE_SCAN_MODE=test E2E_START_SERVER=1 npm run test:e2e`
- [ ] PR CI application·container 결과 확인 (PostgreSQL, NAS 계약, 복구·컨테이너 포함)
- 미실행 항목과 이유 / CI 링크:

## 배포 메모

- main 병합 시 운영 NAS 자동 배포·migration 영향, 순서와 복구 시 유의점:
- 필요한 회사 결정 또는 승인:
