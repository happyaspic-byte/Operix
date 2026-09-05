# Operix v0.2 운영·복구 절차

운영 구성은 Node.js 24, PostgreSQL 17, web·worker·ClamAV와 HTTPS 프록시다. 로컬 PGlite는 개발/검증 용도다. 실서버의 DNS·VPN·인증서·외부 보관은 이 저장소의 CI 검증 범위에 포함되지 않는다.

## 설치와 최초 접근

Docker Engine/Compose, Git, age, Python 3.12 이상, rsync가 있는 Linux 호스트를 준비한다. ClamAV만으로도 권장 메모리 4GiB를 고려해야 하며 앱·DB·이미지 빌드 메모리는 별도로 산정한다. 저장소의 스캐너 제한은 4GiB다. 동시 사용자·첨부 규모에 따른 서버 처리 용량은 실측 전이다. [ClamAV Docker 문서](https://docs.clamav.net/manual/Installing/Docker.html)

```bash
git clone https://github.com/happyaspic-byte/Operix.git
cd Operix
cp .env.example .env
chmod 600 .env
# 아래 값을 각각 독립된 난수/회사 값으로 설정한다.
nano .env
docker compose up --build -d
docker compose ps
docker compose logs --tail=80 migrate web worker scanner
```

| 변수 | 운영 값 |
| --- | --- |
| APP_URL | 실제 HTTPS 주소 |
| SESSION_SECRET | 독립된 32자 이상 난수 |
| SECURITY_LOG_KEY | 세션 키와 다른 32자 이상 난수. 로그·파기 원장의 검증에 필요 |
| POSTGRES_PASSWORD | 독립된 비밀번호. 내부 연결 URL을 위해 hex 난수 권장 |
| ADMIN_EMAIL / ADMIN_PASSWORD | 최초 관리자, 최소 12자 초기 비밀번호 |
| SEED_DEMO | `0` |
| FILE_SCAN_MODE | `clamav` |
| TRUST_PROXY_HEADERS | 승인된 프록시가 클라이언트 헤더를 덮어쓸 때만 `1` |
| SESSION_IDLE_MINUTES | 회사 정책에 따른 5~480분, 기본 30분 |
| UPLOAD_STORAGE_LIMIT_MB | 저장량 한도, 기본 10240MB |
| BACKUP_REQUIRED | 예약 백업·경보를 설치하고 확인한 뒤 `1` |
| BACKUP_MAX_AGE_HOURS | 백업 지연 readiness 기준, 기본 26시간 |

`openssl rand -hex 48`을 필요한 키마다 별도로 실행해 생성할 수 있다. 실제 키를 Git에 넣지 않는다. Compose는 내부 DATABASE_URL을 구성하며 DB/스캐너 포트는 호스트에 노출하지 않는다. 웹은 127.0.0.1:3000에 연결된다.

`deploy/nginx.conf.example`의 도메인·인증서·프록시 설정을 적용한다. 외부가 보낸 IP 값을 그대로 신뢰하지 않도록 `X-Operix-Client-IP`를 프록시가 덮어쓰며, 직접 웹 포트 접근은 차단한다. 헤더 신뢰를 끄면 접속지는 `unknown`으로 기록되고 로그인 제한도 같은 접속지로 집계된다.

운영 web은 HTTPS 주소·독립 키·스캐너 구성 누락 시 기동을 거부한다. `OPERIX_EMBEDDED`, `OPERIX_CONTAINER_TEST`, `FILE_SCAN_MODE=test`, `CI`는 로컬/격리 CI 검증 예외이며 운영에서 설정하지 않는다. nonce CSP는 동적 페이지 렌더링과 함께 적용한다.

migrate 완료 후 web/worker가 시작된다. 최초 로그인과 관리자 비밀번호 재설정 이후에는 본인 비밀번호를 변경해야 업무에 접근할 수 있다. 기존 관리자 비밀번호는 seed가 덮어쓰지 않는다. 초기 계정 발급은 관리자의 설정 화면을 사용하고 사내 전달 절차를 따른다. MFA/IdP는 아직 연결되지 않았다.

## 기존 v0.1 업그레이드

1. 기존 소스 커밋·설정·DB·파일의 복구 가능한 암호화 백업을 보관한다. v0.1 백업 형식은 새 복원 스크립트와 호환되는 것으로 가정하지 않는다. 구버전은 같은 버전의 격리 환경에 복원한 뒤 업그레이드한다.
2. 쓰기 서비스를 멈추고 새 코드를 받아 이미지를 빌드한다. 적용된 SQL 마이그레이션은 수정하지 않는다.
3. migrate가 002/003을 순서대로 적용한다. 실패하면 쓰기 서비스를 재개하지 않는다.

```bash
docker compose stop web worker
docker compose build
docker compose run --rm migrate
docker compose up -d web worker scanner
```

예전 `/app/storage` 볼륨의 내부 `uploads/` 경로는 준비 스크립트가 UUID 파일만 새 업로드 루트로 이동한다. 충돌하면 멈춘다. 기존 파일/보고서는 기본 제한 등급, 기존 파일은 검사 대기 상태가 된다. 관리자·업무 관리자가 문서의 등급을 검토하고 worker의 검사 완료를 확인해야 다운로드할 수 있다. 개인정보 보유 정책은 회사 승인 내용을 입력하며 임의의 공통 기간을 넣지 않는다.

## 운영 상태와 접속기록

`/api/health`는 DB·마이그레이션·남은 디스크·worker 마지막 성공을 확인하고, 활성화한 경우 백업 지연도 확인한다. 문제가 있으면 503을 반환한다. 상세 상태/DB pool 값은 관리자의 설정 화면에서 본다. worker는 이전 작업 종료 후 다음 주기를 시작하고 DB lease로 중복 실행을 억제한다. 실제 운영의 경보 수신처는 모니터링 시스템에서 연결한다.

보안 접속기록과 파기 원장은 `/app/storage/security`의 독립 볼륨에 둔다. 관리자·업무 관리자는 접속기록 점검 화면에서 기간과 결과를 검토하고 기록한다.

```bash
docker compose run --rm --no-deps web node --import tsx scripts/verify-access-logs.ts
```

이 도구는 존재하는 일별 로그 파일 내부의 서명을 검사한다. 파일 전체 삭제·잘림의 독립 탐지를 위해 외부 보관 목록과 불변 저장이 필요하다. 회사 보관 기간과 점검 주기를 정하고 서명 키·보안 볼륨·파기 원장을 별도 보호/복제한다. 동일 호스트 root까지 방어하는 WORM 구성은 아니다.

## 암호화 백업

운영 백업은 age 수신자 공개키를 필수로 받는다. 복호화 개인키는 웹 호스트와 분리해 보호하고 복구 담당자가 접근 가능한지 시험한다. 백업에는 자격증명이 들어 있는 runtime.env가 암호화된 아카이브 안에 포함된다. 평문 임시 공간은 접근을 제한하고 종료 시 정리하지만 디스크 보안 삭제를 보장하지 않으므로 호스트 저장 장치 보호도 필요하다.

```bash
BACKUP_AGE_RECIPIENT=age1... bash scripts/backup.sh /srv/operix-backups
```

스크립트는 web/worker를 잠시 멈추고 DB dump·파일·manifest·스키마 체크섬·파기 기록을 같은 시점으로 보관한다. 알려지지 않은 파일/크기/해시 불일치 시 실패한다. 암호화 성공/실패 후 서비스 재개를 시도한다. 실행 간 중복을 피하고 점검 시간을 정한다. backup_runs의 완료 표시는 로컬 암호화 백업 성공이며 외부 복제 성공의 증명이 아니다.

예약/외부 복제 예시는 `deploy/systemd/operix-backup.service`, `.timer`와 `scripts/scheduled-backup.sh`다. `/opt/operix` 및 `/etc/operix/backup.env`를 실제 경로로 맞추고 권한 0600으로 아래 값을 구성한다. SSH 대상·키·호스트 키는 운영자가 사전 승인/확인한다.

```text
BACKUP_ROOT=/srv/operix-backups
BACKUP_AGE_RECIPIENT=age1...
BACKUP_REMOTE=backup-host:/backups/operix
```

확인 후 unit을 설치하고 타이머를 활성화한다. 예시는 한국시간 매일 02시와 최대 5분 임의 지연이며 여기서 자동 설치한 상태가 아니다. 외부 복제는 암호화된 결과만 rsync한다. 실행 로그/실패 경보·보존 기간·백업 지연 감시를 연결한다. RPO/RTO와 PITR은 회사 목표와 복구 훈련으로 정하며 매일 타이머만으로 보장하지 않는다.

## 빈 볼륨으로 복구

동일 소스/스키마의 애플리케이션과 `.env`, 실행 가능한 DB를 먼저 준비한다. 완전히 잃은 DB 서버라면 빈 DB를 기동하고, **현재까지의 파기 원장과 보안 로그 볼륨을 외부 보관에서 먼저 복구**한다. 오래된 백업에 포함된 파기 기록만 사용하면 그 이후 삭제 요청을 알 수 없다.

```bash
CONFIRM_RESTORE=YES BACKUP_AGE_IDENTITY=/secure/age-key   bash scripts/restore.sh /srv/operix-backups/선택한-백업
```

복호화·아카이브 경로/유형·체크섬·스키마 확인 후 쓰기를 중지한다. 새 이름의 빈 파일 볼륨에만 풀고, PostgreSQL을 단일 트랜잭션으로 복원한다. 문서의 개수/ID/키/크기/SHA-256 및 실제 파일 목록, DB 마이그레이션을 검사한다. 과거 세션을 회수하고 백업 이후 개인정보 파기를 다시 적용한 뒤 새 볼륨으로 web/worker를 재생성한다.

중지 이후 실패하면 쓰기 서비스는 멈춘 채로 남는다. 오류를 조사하기 전 자동 재개하지 않는다. 이전 볼륨은 자동 삭제하지 않으므로 회사의 보존 예외/파기 정책에 따라 식별하고 통제해 폐기한다. 고객·자산·확정 보고서·원본 첨부 바이트·파기 자료 비노출을 인수 확인한다. 이전 이미지로 돌아가는 것과 DB를 되돌리는 것은 별도 절차다.

보안 볼륨·외부 백업·구버전 볼륨까지 파기됐다고 앱이 자동 보증하지 않는다. 파기 요청의 외부 사본 단계는 관리자가 검토 근거를 남긴 뒤 완료한다.

## 실운영 인수

실제 사용자 수·자산/파일 규모로 부하/메모리와 복구 시간을 측정한다. 현장 접수→배정→조치→후속 티켓→고객 제출을 수행하며 회사 보고서 양식·장문/사진·실기기·권한을 확인한다. [개선 추적표](IMPROVEMENTS-2026-09-05.md)의 남은 범위와 운영 정책을 함께 승인한다.
