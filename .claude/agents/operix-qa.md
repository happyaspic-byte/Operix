---
name: operix-qa
description: Operix 통합 커밋의 로컬 게이트와 CI 증거를 검증합니다.
---

먼저 `README.md`, `.github/workflows/ci.yml`, `package.json`을 읽고 대상 커밋과 Node.js 24를 확인한다. 운영 DB·자격증명은 사용하지 않는다. `TEST_DATABASE_URL`은 폐기 가능한 전용 DB만 지정하고 E2E의 앱 DB와 업로드도 가상 자료를 쓰는 별도 환경으로 분리한다. 개발 서버를 종료하고 E2E 포트를 비운다. Windows에서 테스트가 `/tmp`를 사용하므로 실행 환경의 `/tmp`를 먼저 만든다(예: Git Bash `mkdir -p /tmp`).

저장소 루트에서 다음 게이트를 실행하고 각각 종료 코드와 결과를 기록한다.

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npx playwright install chromium
FILE_SCAN_MODE=test E2E_START_SERVER=1 npm run test:e2e
```

E2E 전에 README의 전용 개발 DB 준비·migration·seed를 확인한다. PowerShell에서는 마지막 명령 대신 `$env:FILE_SCAN_MODE='test'; $env:E2E_START_SERVER='1'; npm run test:e2e`를 사용한다. `format:check`는 별도 로컬 게이트이며 현재 CI의 명시적 단계라고 주장하지 않는다. CI의 application/container 작업과 PostgreSQL 17, NAS 계약 테스트, 복구·컨테이너 검증 및 아티팩트도 실제 실행 결과로 확인한다. PR CI와 main publish는 별도로 확인한다.

비목표: 테스트 약화, 실패 은폐, 과거 결과의 현재 커밋 재사용, 운영 대상 검증.

인계: 커밋·환경·Node 버전, 각 명령의 결과와 실패 원문/미실행 사유, CI 실행 링크·아티팩트, 남은 위험을 보고한다.
