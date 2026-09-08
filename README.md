# Operix

고객사, 설치 자산, 계약과 현장 업무를 연결하는 사내 ERP입니다.

[![Verification](https://github.com/happyaspic-byte/Operix/actions/workflows/ci.yml/badge.svg)](https://github.com/happyaspic-byte/Operix/actions/workflows/ci.yml)

![Operix dashboard](docs/screenshots/dashboard-desktop.jpg)

## v0.2 기능

- 고객사·사업장·담당자 관리.
- 시스템 자산, everRun 노드·Endurance 구성요소, VM과 사양 관리.
- 회사 유지보수·제조사 지원·제품 사용권 구분, 여러 자산 연결, 갱신 상태.
- 한 점검에 같은 고객의 여러 자산 연결, 반복 점검 생성, 체크리스트·결과·후속 조치, 담당자 배정.
- 장애·작업 접수, 조치 이력, 관찰 사실·내부 추정·제조사 확인 구분.
- 비공개 첨부 파일, 확정 시점이 보존되는 보고서, 인쇄·PDF 저장.
- XLSX·CSV 내보내기, 가져오기 매핑·검증·중복 방지·일괄 반영.
- 관리자·업무 관리자·기술지원·영업·조회 전용 역할, 서버 권한 검사.
- 로그인 세션 회수, 변경 이력, 동시 수정 충돌 감지, 앱 내부 알림.

공개 저장소의 예제·화면·테스트에는 가상 자료만 사용합니다. 운영 자격증명과 실제 고객 자료는 저장소에 포함하지 않습니다.

## 개선과 검증

첨부 진단 33개 항목을 추적해 보안·관계 무결성·조회·업무 화면·복구 절차를 개선했습니다. 코드 개선 범위 기준 **완료 13개 · 부분 완료 19개 · 후속 확장 1개**입니다.

문서 기밀등급/ClamAV 격리, 개인정보 보유·파기와 복구 후 재적용, 접속기록 점검, 본인 비밀번호/세션 관리, 인수인계, SLA·주월 일정·후속 티켓, 다중 고객 담당자, 필터 내보내기와 확대된 가져오기를 제공합니다.

**2026-09-05 검증: 도메인 63/63 + 브라우저 16/16 통과** ([검증 커밋 eb60e1f](https://github.com/happyaspic-byte/Operix/commit/eb60e1f4554812b8a891aacaf635c4cf28b7afda)). 개선안 대응 점수는 공개 산식 기준 **68.2/100**이며 보안 인증이나 ERP 완성도 점수가 아닙니다.

**2026-09-08 worktree 통합 검증: PostgreSQL 단위·DB 110/110 + 브라우저·API 33/33 통과.** UI·보안·버그 수정·문서 변경을 최신 main 기준에 병합했고, 타입 검사·lint·빌드도 통과했습니다. [통합 기록](docs/INTEGRATION-2026-09-08.md)에 실행별 코드 기준과 로컬 결과를 구분했습니다. 커밋별 원격 검증 결과는 [GitHub Actions](https://github.com/happyaspic-byte/Operix/actions/workflows/ci.yml)에서 확인하세요.

[33개 개선 추적표](docs/IMPROVEMENTS-2026-09-05.md) · [실행 결과·점수·화면](docs/VERIFICATION.md) · [자동 검증](https://github.com/happyaspic-byte/Operix/actions/workflows/ci.yml) · [ERP 비교](docs/COMPARISON.md).

회사별 개인정보 정책·MFA/IdP·HTTPS/VPN·외부 로그/백업·RPO/RTO 및 현장 인수는 남아 있습니다. 완료 항목 수는 전사 ERP 완성도나 운영 승인 점수가 아닙니다.

## 사내 Ubuntu 설치

[설치·업데이트·백업·복구 가이드](docs/DEPLOYMENT.md)를 따르세요.

```bash
cp .env.example .env
# 실제 HTTPS 주소, 관리자·DB 비밀번호, 서로 다른 세션·접속기록 키를 설정하세요.
docker compose up --build -d
```

PostgreSQL이 준비되면 스키마와 최초 관리자 계정을 생성한 뒤 웹과 일정 처리기가 실행됩니다. ClamAV 검사기도 함께 구성됩니다. 운영에서는 SEED_DEMO=0을 사용합니다. 외부 접속은 사내 HTTPS 프록시와 승인된 VPN 구성을 이용합니다.

## 로컬 개발·검증

Node.js 24 필수. 아래 명령은 해당 저장소 또는 worktree 루트에서 실행합니다. 시작 전에 기존 `.env`와 셸의 환경변수가 개발용 DB·계정을 가리키는지 확인하세요. `setup:local`은 기존 `.env`를 보존하므로 운영 설정을 로컬 설정으로 바꾸지 않습니다. Docker 없이 확인할 때만 PGlite를 명시적으로 활성화합니다.

```bash
npm ci
npm run setup:local
npm run db:migrate
npm run db:seed
npm run dev
```

로컬 계정은 admin@operix.test이며 비밀번호는 setup:local이 무작위로 생성해 .env의 ADMIN_PASSWORD에 저장합니다. 운영 계정에는 이 로컬 설정을 재사용하지 마세요.

여러 worktree를 동시에 실행할 때는 각각의 `.env`에서 `APP_URL`과 `PORT`를 맞추고, DB 또는 `PGLITE_PATH`, `UPLOAD_DIR`, `SECURITY_LOG_DIR`를 분리하세요. 테스트 산출물도 각 worktree 안에 보관합니다. 같은 절대 경로를 여러 작업에 공유하지 마세요.

다음 검증 전에는 개발 서버를 종료합니다. E2E는 `build` 결과로 전용 서버를 시작하므로 `APP_URL`과 `PORT`가 가리키는 포트를 비워 두세요.

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
FILE_SCAN_MODE=test E2E_START_SERVER=1 npm run test:e2e
```

단위·DB 검증은 기본적으로 별도 메모리 DB를 사용합니다. `TEST_DATABASE_URL`이 있으면 해당 PostgreSQL DB를 이용하므로 폐기 가능한 전용 테스트 DB만 지정하세요. E2E 서버는 `.env`의 앱 DB를 사용하므로 가상 자료로 준비한 별도 개발·검증 DB가 필요합니다. GitHub Actions는 실제 PostgreSQL 17, Chromium, DB·첨부 파일 복구 및 Docker 컨테이너 기동을 검사합니다.

## 문서

- [개발 계획](docs/PLAN.md)
- [이번 개선 항목 추적](docs/IMPROVEMENTS-2026-09-05.md)
- [검증 결과와 평가](docs/VERIFICATION.md)
- [2026-09-08 worktree 통합 기록](docs/INTEGRATION-2026-09-08.md)
- [작업 역할별 프롬프트 기록](docs/agent-prompts/README.md)
- [다른 ERP와의 비교](docs/COMPARISON.md)
- [설치와 운영](docs/DEPLOYMENT.md)
- [점검 대상 자산 여러 개 선택](docs/INSPECTION-ASSETS.md)

현재 버전은 고객·자산·유지보수 범위입니다. 영업·구매·재고·재무·인사는 후속 확장 대상입니다. 실제 사내 자료 이관, 운영망·인증서 구성과 현장 복구 시험은 해당 환경에서 진행해야 합니다.
