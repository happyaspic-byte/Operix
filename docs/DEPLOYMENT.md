# 사내 Ubuntu 설치와 운영

Operix는 회사 내부용 고객·자산·유지보수 애플리케이션이다. 운영 환경은 PostgreSQL과 Docker Compose를 사용한다. Node.js 24 기반 이미지를 제공한다.

## 1. 준비

- Docker Engine과 Docker Compose 플러그인이 설치된 Ubuntu.
- 초기 검토 기준: 2 vCPU / 메모리 4GB 이상 / SSD. 이는 검증된 부하 한계가 아니며 동시 사용자·첨부 파일 용량에 따라 산정한다. 이미지 빌드에는 별도의 메모리 여유가 필요하다.
- 사내 DNS 또는 VPN 접속 주소, HTTPS 인증서, 별도 백업 저장 대상.
- PostgreSQL 포트는 호스트에 공개하지 않는다. 웹은 기본적으로 호스트의 127.0.0.1:3000에만 연결한다.

## 2. 설정

```bash
git clone https://github.com/happyaspic-byte/Operix.git
cd Operix
cp .env.example .env
chmod 600 .env
openssl rand -hex 48
openssl rand -hex 24
nano .env
```

첫 난수는 SESSION_SECRET, 별도의 난수는 POSTGRES_PASSWORD 등에 사용한다. 서로 다른 운영 비밀번호를 선택한다. Compose는 POSTGRES_PASSWORD로 내부 DATABASE_URL을 구성한다. URL 문제를 피하려면 DB 비밀번호는 영문·숫자 또는 hex 난수를 사용한다.

| 변수              | 설정                                                |
| ----------------- | --------------------------------------------------- |
| APP_URL           | 실제 접속 주소. 예: https://operix.example.internal |
| SESSION_SECRET    | 32자 이상 독립된 난수                               |
| POSTGRES_PASSWORD | 독립된 DB 비밀번호                                  |
| ADMIN_EMAIL       | 실제 최초 관리자 이메일                             |
| ADMIN_PASSWORD    | 12자 이상 최초 관리자 비밀번호                      |
| SEED_DEMO         | 운영 환경은 0                                       |

로컬 확인은 APP_URL=http://localhost:3000으로 시작할 수 있다. 사내 HTTPS 주소로 운영하기 전 APP_URL을 실제 주소로 변경한다. 요청 출처 검사와 Secure 쿠키가 이 값을 사용한다.

## 3. 실행

```bash
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 migrate web worker
curl --fail http://127.0.0.1:3000/api/health
```

DB 준비 후 migrate 서비스가 스키마와 최초 관리자 계정을 준비한다. 성공 후 웹과 일정 작업 프로세스가 실행된다. 다시 실행해도 기존 관리자 비밀번호를 덮어쓰지 않는다.

기존 Portainer에서 운영한다면 이 저장소의 compose.yaml과 환경 변수를 동일하게 사용한다. 소스 빌드가 가능한 Git Stack 환경인지 확인한다.

## 4. 접속과 계정

호스트의 Nginx 등 역방향 프록시에서 HTTPS를 종료하고 127.0.0.1:3000으로 전달한다. deploy/nginx.conf.example의 주소와 인증서 경로를 실제 환경에 맞춘다. VPN과 사내 방화벽에서 허용한 접속 경로로 이용한다.

관리자 로그인 후 설정 → 임직원 계정 발급에서 계정을 만든다. 초기 비밀번호 전달은 사내 절차를 이용한다. 자체 회원가입은 제공하지 않는다. 사용자 정지·역할·비밀번호 변경 시 기존 세션을 회수한다.

## 5. 백업과 복구

```bash
bash scripts/backup.sh /srv/operix-backups
```

백업 스크립트는 웹·작업 프로세스를 잠시 멈춰 데이터 변경을 정지한 뒤 PostgreSQL 덤프와 첨부 파일을 같은 시점으로 보관한다. 완료 후 서비스를 다시 시작한다. 점검 시간을 정해 실행한다.

백업에는 runtime.env가 포함되어 자격증명이 들어 있다. 접근을 제한하고 암호화된 별도 저장 대상으로 복사한다. 출력 디렉터리는 기본 0700 수준의 umask를 적용한다. 백업 스케줄·보존 기간·외부 복제는 운영자가 정한다. 초기 제안은 매일·30일 보존이며, 매일 백업이면 최대 약 하루의 변경이 손실될 수 있다.

복원은 먼저 별도 빈 환경에서 검증한다. 같은 애플리케이션 소스 버전과 설정을 준비한 후:

```bash
CONFIRM_RESTORE=YES bash scripts/restore.sh /srv/operix-backups/선택한-백업
```

대상 DB의 내용을 교체한다. 실패하면 웹과 작업 프로세스를 정지한 채 오류를 확인한다. 로그인, 고객·자산 건수, 첨부 파일, 확정 보고서를 점검한다. 기존 파일 볼륨에 복구하면 덤프에서 참조하지 않는 여분 파일이 남을 수 있으므로 신규 복구 볼륨을 권장한다.

## 6. 업데이트

백업 후 변경 내역과 DB 마이그레이션을 확인한다. 검증된 커밋이나 태그로 체크아웃하고 이미지를 재빌드한다. DB 변경에는 자동 역마이그레이션을 제공하지 않는다. 애플리케이션 이미지 롤백과 DB 복구는 별도 판단한다.

```bash
docker compose stop web worker
docker compose build
docker compose run --rm migrate
docker compose up -d web worker
```

## 운영 검증 범위

로컬 검증용 내장 PostgreSQL 엔진(PGlite)은 설치 편의와 테스트 용도다. 운영에서는 DATABASE_URL을 필수로 지정한다. 별도 worker는 PostgreSQL 서버가 필요하다. 실제 사내 서버의 DNS·인증서·방화벽·스토리지·백업 대상은 이 작업 환경에서 접속 검증하지 않았다.
