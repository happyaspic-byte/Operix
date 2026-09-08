# Operix 워크트리 에이전트 프롬프트

작성일: 2026-09-06. 작성에 참고한 Operix 커밋: `0bf3d370d021`.
이 커밋은 작성 근거이며 실행 시 강제할 기준은 아니다. main-pc의 실제 저장소·의존성·지침을 먼저 확인하고 통합 담당이 정한 기준에서 시작한다.

## 파일과 사용법

| 파일 | 역할 | 실행 시점 | 제안 포트 |
| --- | --- | --- | --- |
| [01-ui-improve.md](01-ui-improve.md) | 화면·반응형·접근성·상호작용 개선 | 독립 범위 배정 후 병렬 | 3101 |
| [02-security-improve.md](02-security-improve.md) | 확인된 인증·인가·입력 경계 보안 문제 수정 | 독립 범위 배정 후 병렬 | 3102 |
| [03-bug-fix.md](03-bug-fix.md) | 업무·데이터 처리 결함 재현 및 수정 | 독립 범위 배정 후 병렬 | 3103 |
| [04-docs-sync.md](04-docs-sync.md) | 통합 코드와 문서 동기화 | 코드 통합·검증 후 | 3104, 필요할 때만 |

각 프롬프트는 공통 계약을 포함하므로 **해당 파일 전체를 역할별 에이전트의 첫 메시지에 붙여 넣으면 된다.** `00-README.md`를 별도로 붙일 필요는 없다. 별도 에이전트 유형이나 특정 모델 설정도 요구하지 않는다.

특정 화면·버그·보안 이슈가 있으면 프롬프트 아래에 추가한다. 없어도 실제 코드와 동작을 조사해 담당 범위에서 진행하도록 작성했다. 가능한 경우 작업 시작 메시지에 기준 커밋, worktree 경로, 담당 이슈, 조율할 통합 담당을 함께 알려준다.

프롬프트 작성·전송은 실제 UI·보안·버그 수정이나 앱 검증을 실행한 것이 아니다. 각 에이전트의 작업은 파일을 전달해 실행할 때 시작된다.

## 실행 순서

1. 통합 담당 한 명을 정한다. 사용자 본인이나 별도 조정 에이전트가 맡을 수 있다. 네 에이전트가 직접 통신할 수 없다면 통합 담당이 `needs-coordination` 요청과 인계 보고를 전달한다.
2. 공통 기준 커밋과 담당 범위를 고정한다. 미커밋 변경은 새 worktree에 자동으로 포함되지 않으므로 사용자의 기존 작업을 어떻게 반영할지 먼저 확인한다. 자동 stash/reset을 사용하지 않는다.
3. UI·보안·bug-fix용 worktree에서 각각 실행한다. 아래 기본 소유권 안에서는 병렬 수정하고 공용 파일이 필요하면 통합 담당이 한 역할에 배정하거나 선행 작업을 통합한 뒤 후속 작업을 갱신한다.
4. 통합 담당이 결과와 검증 증거를 읽고 의존성 순서에 따라 하나씩 통합한다. 인증·API 계약 등 다른 변경의 전제가 되는 수정을 먼저 반영한다. Git 충돌이 없더라도 기능이 함께 동작하는지 확인한다.
5. 통합 기준에서 typecheck·단위/DB·build·필요한 E2E를 실행한다. 각 브랜치의 통과 결과만으로 최종 통과를 선언하지 않는다.
6. 검증된 통합 커밋에서 docs-sync worktree를 만들거나 기존 docs-sync worktree를 통합 담당이 안전하게 갱신한다. 세 역할의 인계 보고와 검증 기록을 전달하고 `04-docs-sync.md`를 실행한다.
7. 문서 변경을 검토·통합하고 링크와 기록의 정확성을 확인한다. push·배포는 별도의 사용자 지시에 따른다.

## 기본 파일 소유권

| 소유자 | 직접 수정 범위 |
| --- | --- |
| UI | `src/components/**`, `src/app/globals.css`, 페이지·레이아웃·화면 상태의 표현 계층 |
| 보안 | `src/lib/auth.ts`, `src/lib/policy.ts`, `src/lib/http.ts` |
| bug-fix | `src/lib/records.ts`, `dates.ts`, `jobs.ts`, `catalog.ts`, `details.ts`, `overview.ts` |
| docs-sync | `README.md`와 관련 최신 가이드. 과거 감사 기록·에이전트 지침은 임의 변경 제외 |
| 조율 필요 | `src/lib/validation.ts`, `sheets.ts`, `db.ts`, `src/app/api/**`, 설정·의존성·잠금·DB·실행/배포 스크립트·CI, 기존 공용 테스트 |

이는 출발점이다. 예를 들어 실제 보안 결함이 API 파일에 있으면 통합 담당이 해당 파일을 보안 역할에 배정한다. 공용으로 표시됐다는 이유만으로 문제를 버리거나, 같은 파일을 서로 몰래 수정하지 않도록 한 구조다. 역할별 새 테스트도 DB 상태를 공유하는지 확인해야 한다.

## main-pc에서 worktree를 준비하는 예시

기존 worktree가 있다면 재사용한다. 아래는 Windows PowerShell에서 **Operix 저장소 루트**를 현재 디렉터리로 둔 경우의 예시다. 같은 이름의 경로·브랜치가 있으면 다른 이름을 사용한다. 명령이 실패하면 원인을 확인하고 실패한 생성에 기대어 다음 작업을 시작하지 않는다.

```powershell
git status --short
git worktree list
$operixBase = (git rev-parse HEAD).Trim()
git worktree add -b feat/operix-ui-20260906 ../Operix-ui-20260906 $operixBase
git worktree add -b fix/operix-security-20260906 ../Operix-security-20260906 $operixBase
git worktree add -b fix/operix-bugs-20260906 ../Operix-bugs-20260906 $operixBase
```

각 디렉터리를 해당 에이전트의 작업 경로로 지정하고 일치하는 프롬프트를 전달한다. `.env`, `node_modules`, `.next`, DB·업로드 자료는 Git worktree 생성으로 복사되지 않으므로 에이전트가 전용 로컬 환경을 준비하도록 한다.

docs-sync는 코드 통합과 검증이 끝난 뒤, **검증된 통합 커밋을 checkout한 관리 디렉터리**에서 다음처럼 만든다.

```powershell
$operixIntegrated = (git rev-parse HEAD).Trim()
git worktree add -b docs/operix-sync-20260906 ../Operix-docs-20260906 $operixIntegrated
```

docs-sync 시작 메시지에 `$operixIntegrated`의 실제 값과 통합 완료 사실, 세 역할의 검증·문서 인계 보고를 함께 제공한다. 이 예시는 worktree 준비만 수행하며 브랜치 병합이나 배포를 실행하지 않는다.

## 환경 분리와 완료 판단

- `PORT`와 `APP_URL`을 일치시키고, 각 worktree에 전용 `.env`, DB, 업로드·테스트 산출물 경로를 둔다. 제안 포트가 사용 중이면 다른 포트를 사용한다. 운영 자격증명을 복제하지 않는다.
- `npm run setup:local`은 기존 `.env`를 보존한다. 명령 실행만으로 안전한 전용 설정이 되었거나 포트가 변경되었다고 가정하지 않는다.
- 새 환경에서 기본 Playwright 브라우저를 사용하려면 `npx playwright install chromium`으로 준비한다. 별도 브라우저를 사용하는 경우 경로와 플랫폼 호환성을 확인한다.
- 현재 E2E는 `E2E_START_SERVER=1`일 때 `npm run start`를 실행하므로 사전 빌드·전용 가상 데이터 준비가 필요하다. `TEST_DATABASE_URL`을 쓰는 DB 테스트와 `DATABASE_URL`/PGlite를 쓰는 앱/E2E 환경도 구분한다.
- 에이전트 결과의 `complete`는 맡긴 범위와 필수 검증을 완료했다는 뜻이다. `partial`, `needs-coordination`, `blocked`가 있으면 그 이유와 남은 작업을 확인한다. 결함을 찾지 못한 조사도 범위·한계를 정직하게 보고하도록 했다.
- 검증하지 않은 성공, 정적 분석만으로 확정한 취약점, 자동 검사만으로 선언한 접근성 준수, 과거 테스트 수치를 현재 결과로 재사용하는 것을 금지했다.

## 파일 무결성

압축에는 위 Markdown 파일 다섯 개와 `SHA256SUMS.txt`가 들어 있다. 파일을 수정하지 않았다면 해당 해시로 내용을 비교할 수 있다. PowerShell에서는 `Get-FileHash -Algorithm SHA256 .\01-ui-improve.md`처럼 확인한다.
