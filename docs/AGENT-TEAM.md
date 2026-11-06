# Operix 에이전트 팀 운영

이 안내는 현재 저장소를 기준으로 한다. `AGENTS.md`와 상위 지시가 우선하며, 날짜별 [역할 프롬프트](agent-prompts/README.md)는 과거 기록이다. Claude Code의 `.claude/agents/` 정의를 사용하거나 역할 지시를 다른 도구에 전달할 수 있다. 자동 위임이나 운영 권한이 항상 존재한다고 가정하지 않는다.

## 역할

| 에이전트 | 책임 |
| --- | --- |
| `operix-orchestrator` | 단계·소유권·worktree·migration 배정, 통합·게이트·순차 배포 조율 |
| `operix-feature-dev` | 배정된 기능·회귀 테스트와 안전한 스키마 변경 |
| `operix-reviewer` | 역할·문서 등급·개인정보·migration 및 무결성 검토 |
| `operix-qa` | 통합 커밋 게이트, PR CI와 main 게시 결과 확인 |
| `operix-docs` | 통합 근거에 맞춘 현재 문서와 추적표 동기화 |
| `operix-deps` | Dependabot 업데이트 통합·호환성 검토·대체 PR 정리 |

## 표준 흐름

1. 요청의 사용자·업무 흐름·수용 기준과 운영 영향, 회사 결정 필요 여부를 정한다. 통합 담당 한 명을 지정한다.
2. `docs/superpowers/plans/2026-10-19-phase1-fixes.md`처럼 목표, 단계와 의존성, 파일 소유권, 인터페이스, 테스트·게이트를 계획한다. 현재 main과 기존 미커밋 변경을 확인하고 삭제하거나 자동 stash/reset하지 않는다.
3. 독립 작업은 같은 기준 커밋의 전용 worktree에서 병렬 수행한다. 공용 파일, 같은 테스트 hunk, 정책·API·스키마 변경은 통합 담당이 소유권과 순서를 조율한다. 승인된 변경에 직접 필요한 최소 테스트 동기화는 [v2 계약](agent-prompts/2026-09-06-v2/00-README.md)의 중복 확인·검증·인계 조건을 따른다. 각 환경의 `.env`, `PORT`/`APP_URL`, DB 또는 `PGLITE_PATH`, 업로드·로그·결과 경로를 분리하고 운영 자격증명이나 실자료를 사용하지 않는다.
4. 코드·보안 리뷰 후 통합 기준에서 Node 24로 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, README의 E2E를 실행한다. 실패·미실행은 결과와 함께 인계한다. 필요 시 문서를 통합 결과와 동기화한다.
5. PR을 열어 `.github/workflows/ci.yml`의 application·container CI를 확인한다. `format:check`는 별도 게이트이며 현재 CI 단계는 아니다. 각 PR을 최신 main과 호환되게 준비하고 의존 순서대로 **하나씩 squash merge**한다. merge 권한과 배포 승인은 별도로 확인한다.
6. 각 main 병합 뒤 main CI 및 publish 성공, GHCR digest와 `nas-deploy` 갱신, Portainer 배포 및 health를 확인하고 나서 다음 PR을 병합한다. 이 절차는 자동 복구를 보장하지 않는다.

## 브랜치·worktree·migration

브랜치는 `feat/<범위>`, `fix/<범위>`, `chore/<범위>`, `docs/<범위>`처럼 용도를 드러내고 worktree 경로는 서로 다르게 지정한다. 예를 들어 저장소 루트에서 `git worktree add -b feat/visit-mobile ../Operix-visit-mobile <기준커밋>`을 실행한다. 이미 존재하는 경로·브랜치는 덮어쓰지 않는다. worktree 생성은 `.env`, 의존성, DB를 복사하지 않는다.

통합 담당은 `db/`의 현재 최대 번호와 다른 예약을 함께 확인해 각 슬라이스에 유일한 다음 번호·파일명(예: `008_visit_mobile.sql`)을 미리 할당한다. 병합 순서와 파일명 순서가 일치해야 한다. 이미 적용한 SQL은 수정하지 않으며 충돌 시 미배포 파일을 조율해 재배정한다. `scripts/migrate.ts`가 파일명 순서대로 적용한다.

## 운영 배포와 복구

main 변경은 운영 NAS 자동 배포를 유발한다. main의 application/container CI 성공 → 검증된 이미지 GHCR 게시 → digest 고정 `nas-deploy/compose.yaml` 갱신 → Portainer polling → DB 백업 → migration → 앱 기동·상태 확인 순서다. migration은 추가적·멱등이어야 한다: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, 새 열은 nullable 또는 기본값. 기존 객체 DROP/RENAME, 기존 행에 실패할 수 있는 재작성은 금지하고 구버전 앱과의 호환성도 확인한다.

실패 시 자동 롤백되지 않는다. polling을 잠시 끄고 오류와 DB 상태를 확인한다. [NAS 복구 절차](../deploy/nas/README.md#실패와-이전-이미지-복구)에 따라 이전 정상 GHCR digest가 담긴 `nas-deploy` Compose를 새 배포 식별자의 **새 revert commit**으로 적용한다. Git reset으로 대체하지 않는다. 이미지 복구는 migration을 되돌리지 않는다. DB 복원이 필요하면 쓰기를 중단하고 [운영 복구 절차](DEPLOYMENT.md)를 별도로 따른다. 복구 가능 백업과 개인정보 파기 원장을 보호한다.

## 완료 기준

- 요청한 동작·회귀 테스트와 서버 권한, 문서 등급, viewer 감사 비노출(A08), 개인정보 파기·복구 경로를 확인했다.
- 해당 migration이 추가적·멱등이고 기존 데이터 및 배포 순서와 호환된다.
- 통합 커밋의 게이트와 PR CI 증거, 실행하지 못한 항목 및 이유가 기록됐다. 문서·기능 상태는 실제 결과와 일치한다.
- 승인된 순차 merge의 main publish와 NAS 배포·상태를 확인했다. 미승인 또는 실패 시 배포 완료로 표시하지 않는다.

## 세션 시작 예시

- `방문 준비표 모바일 개선해줘. 현재 main을 조사해 범위와 수용 기준을 정하고 operix-orchestrator로 독립 작업과 검증을 조율해줘.`
- `고객 보고서 초안의 내부 자료 노출 위험을 operix-reviewer로 검토하고, 필요한 회사 결정을 먼저 알려줘.`
- `Dependabot PR을 최신 main 기준으로 정리하고 Node 24 검증 결과와 대체 PR을 보고해줘. 병합 전 승인을 받아줘.`

## Phase 2 남은 후보

아래는 [기능 후보](FEATURE-CANDIDATES.md)와 [개선 추적표](IMPROVEMENTS-2026-09-05.md)의 남은 범위 중 요청된 항목이다. 실제 우선순위·구현 상태는 작업 시작 시 다시 확인한다. 회사 결정이 필요한 범위는 결정을 임의로 확정하지 않는다.

| 항목 | 남은 범위 | 회사 결정 |
| --- | --- | --- |
| 기능 후보 2 | 근거를 연결한 고객 보고서 초안: 누락 안내·출처 연결, 내부 추정·제한 문서 제외, 사람이 검토·확정. 원문 수정·자동 발송 없음 | 고객 공개 기준과 승인 흐름 확인 필요 |
| A07 | 세션 만료 사전 알림, 모든 관리 모달의 이탈·입력 보호 | 우선순위/경고 시점 확인 |
| C05 | 고객별 계약 SLA, 영업시간·휴일·대기 제외, 집계 보고 | 계약별 목표·영업시간·휴일·제외 규칙 결정 필요 |
| C06 | 공휴일 자동 이동, 계획 예외 버전, 회차 일괄 배정 | 공휴일 이동·예외 처리 규칙 결정 필요 |
| C07 | 외부 메일/메신저 알림과 단계별 escalation | 채널·수신자·발송 및 escalation 정책 결정 필요 |
| C08 | 계약 금액/기간 비교, 자동 갱신, 부품 교체 전용 이력 | 자동 갱신 조건과 권한 결정 필요 |
| C09 | 고객 확인/서명, 회사 양식, 장문·사진 다페이지 현장 인수 | 회사 양식·고객 확인/서명 절차 결정 필요; 확정은 전자서명이 아님 |
| C11 | 실규모 EXPLAIN·메모리·동시 부하, 비동기 export 및 전역 관계 쓰기 잠금 처리량 | 실규모 시험 자료·목표와 운영 시험 승인 필요 |
| C12 | 사진 미리보기·전송률, 모든 모달·실기기·화면낭독기 검증 | 대상 기기·접근성 인수 기준 확인 |

## CI 유지보수

`.github/workflows/ci.yml`은 `ubuntu-24.04`에 고정한다. PR #23에서 `ubuntu-26.04`의 Docker 29 containerd 이미지 저장소 사용 시 push 후 pull한 이미지 ID가 검증된 ID와 달라 게시 검증이 실패한 문제가 확인됐다. runner를 올릴 때는 검증 이미지와 게시 digest의 동일성 및 전체 publish 경로를 먼저 재검증한다.
