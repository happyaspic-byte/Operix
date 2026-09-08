# Portainer Repository 자동배포

GitHub `main`의 애플리케이션·컨테이너 검증이 모두 성공하면, 실제 검증한 이미지를 `ghcr.io/happyaspic-byte/operix`에 게시한다. CI는 이미지 digest를 고정한 Compose를 `nas-deploy` 브랜치에 커밋한다. Portainer가 이 브랜치를 1분 간격으로 확인하고 자체 Git 배포 기능으로 적용한다.

1분은 변경 확인 주기다. 전체 반영 시간에는 CI 검증, 이미지 다운로드, 백업과 서비스 시작 시간이 추가된다.

```text
main push → application + container 검증 성공
          → GHCR 이미지 게시·익명 다운로드 확인
          → nas-deploy/compose.yaml에 고정 digest 기록
          → Portainer Git polling → DB 백업 → migrate → 앱 기동·health 확인
```

`nas-deploy`는 CI가 관리하는 배포 전용 브랜치다. 앱 소스는 `main`에 유지하고, 운영 구성의 변경은 `deploy/nas/compose.template.json`에서 작성한다. 앱 이미지 참조 3개와 배포 식별자만 CI가 치환한다. 배포 파일에는 비밀값을 넣지 않으며 Portainer의 환경변수를 사용한다. PR·다른 브랜치·이미 오래된 main 실행은 배포 브랜치를 갱신하지 않는다.

## 최초 GHCR 공개 설정

이 저장소와 배포 이미지는 공개 배포를 사용한다. GHCR은 첫 패키지를 기본 비공개로 생성하므로 저장소 소유자가 GitHub의 **Packages → operix → Package settings → Change visibility → Public**을 한 번 설정한다. 이미 Public인 패키지는 이 단계를 생략한다. NAS는 이후 별도 GitHub 토큰 없이 이미지를 가져온다. CI는 익명 pull이 되는지 확인하기 전에는 배포 브랜치를 갱신하지 않는다. 공개 대기 단계가 끝나 실패했다면 설정 후 Actions의 **Re-run failed jobs**로 게시 단계를 재개한다.

## Portainer 설정

| 항목 | 값 |
| --- | --- |
| 배포 방식 | Repository |
| Repository URL | `https://github.com/happyaspic-byte/Operix` |
| Repository reference | `refs/heads/nas-deploy` |
| Compose path | `compose.yaml` |
| Repository authentication | Off — 공개 저장소 |
| GitOps updates | Polling, `1m` |
| Force redeployment | Off |
| TLS verification | On |

Compose의 앱 이미지는 `ghcr.io/...@sha256:...` 형식으로 고정한다. DB·스캐너·HTTPS 이미지도 검증한 digest를 사용한다. `OPERIX_IMAGE` 환경변수는 새 Compose에서 사용하지 않는다. 이전 구성을 복구할 때 참고할 수 있도록 기존 환경변수 값은 보존할 수 있다.

기존 환경변수 외에 `OPERIX_BIND_IP`에는 HTTPS를 제공하는 NAS 내부 IP를 지정한다. `OPERIX_HTTPS_PORT` 기본값은 `9010`이다. 다음 자원은 **이미 존재하는 external 자원**을 참조하므로 설치 전에 실제 이름과 연결을 확인한다.

| 구성 | 기본 자원 이름 |
| --- | --- |
| 앱 네트워크 | `operix_default` (`OPERIX_APP_NETWORK`로 지정 가능) |
| 프록시 네트워크 | `npm_default` (`OPERIX_PROXY_NETWORK`) |
| DB·업로드·보안 로그·스캐너 | 기존 `OPERIX_DB_VOLUME`, `OPERIX_UPLOAD_VOLUME`, `OPERIX_SECURITY_VOLUME`, `OPERIX_SCANNER_VOLUME` 값 |
| HTTPS 인증서·프록시 설정 | `operix_https` |
| 배포 전 DB 백업 | `operix_backups` (`OPERIX_BACKUP_VOLUME`) |

## 기존 Web editor 스택 전환

Portainer CE 2.39.4에서 Web editor 스택을 Git 스택으로 바꾸려면 스택을 다시 만들어야 하므로 한 번의 중단 시간이 필요하다. 전환 전에 현재 Compose·전체 환경변수·실제 볼륨 연결과 복구 가능한 DB 백업을 저장한다. 기존 자동 갱신 프로그램은 진행 중 배포가 없을 때 멈춘다.

1. 현재 앱 네트워크의 이름·드라이버·IPAM(서브넷과 게이트웨이)·옵션을 보존한다. Portainer의 삭제 작업은 Compose의 external 선언만으로 기존 네트워크를 보존하지 않으므로, 삭제 후 네트워크가 사라졌다면 같은 설정으로 재생성할 준비를 한다. 이름 있는 데이터 볼륨은 삭제하지 않는다.
2. NAS에서 GHCR digest 이미지 pull, Compose 구문, 백업 서비스와 기존 HTTPS 구성을 확인한다.
3. 기존 스택을 제거한 후 앱 네트워크를 확인하고, 없으면 보존한 이름·드라이버·IPAM·옵션으로 재생성한다. 재생성할 때 이전 `com.docker.compose.*` 소유 라벨은 붙이지 않는다. 기존 HTTPS 접근 제어에 사용되는 게이트웨이가 같은지 확인한 후, 동일한 프로젝트 이름 `operix`로 Repository 스택을 생성한다. 새 Portainer 스택 ID가 생긴다. 실제 데이터 볼륨은 기존 것을 참조한다.
4. 최초 생성에서는 GitOps polling을 끄고, backup·migrate·deployment-check 종료 코드 0, web healthy, worker와 HTTPS, 기존 데이터·볼륨 연결을 확인한다.
5. Polling `1m`을 켜고 새 배포 브랜치 커밋이 자동 반영되는지 확인한다. 검증 후 이전 업데이터 컨테이너와 전용 API 키를 제거한다. 이전 백업 볼륨은 별도로 보존한다.

Portainer 기본 stack 삭제는 볼륨을 지우지 않지만 별도의 **Remove volumes**나 `docker compose down -v`를 사용하면 안 된다. 최초 Git 스택 생성이 실패하면 보존한 Compose와 전체 환경변수로 같은 프로젝트를 복구한다.

## 백업·상태 확인

`backup`은 PostgreSQL의 `pg_dump -Fc`를 사용하여 migration 전에 DB를 전용 볼륨에 저장한다. 덤프 목차 검사가 성공하면 `.part` 파일을 완성 파일로 바꾼다. 같은 배포 식별자의 기존 백업은 검사 후 재사용하여 재시도로 원본이 덮어써지지 않게 한다. 파일 권한은 `0600`, 디렉터리는 `0700`이며 최근 7개 DB 덤프를 보존한다.

`migrate`는 backup 성공 후 실행한다. `deployment-check`는 web health와 worker·HTTPS 시작을 기다리는 일회성 서비스다. Portainer의 스택 화면에서 다음을 확인한다.

- `backup`, `migrate`, `deployment-check`: 종료 코드 0
- `web`: healthy
- `worker`, `db`, `scanner`, `https`: 실행 중
- 실제 서비스의 `/api/health`: 정상 응답

이 DB 덤프는 NAS 로컬의 배포 전 복구 자료다. 첨부파일까지 같은 시점으로 보관하는 암호화 백업·외부 복제는 [운영·복구 절차](../../docs/DEPLOYMENT.md)의 기존 절차를 따른다.

## 실패와 이전 이미지 복구

**Portainer Repository 자동배포는 이전 이미지로 자동 롤백하지 않는다.** backup·migration·앱 기동 실패 시 기존 서비스가 계속 실행된다고 보장할 수도 없다. 실패하면 GitOps polling을 잠시 끄고 오류와 DB 변경 여부를 확인한다.

이전 이미지를 적용하려면 `nas-deploy`의 이전 정상 `compose.yaml`을 바탕으로 **새 revert commit**을 만든다. backup의 `DEPLOYMENT_ID`와 deployment-check의 `operix.deployment`에는 `rollback-20260908-153000`처럼 새로운 식별자를 넣는다. 이전 Git SHA로 단순 reset하면 Portainer가 이미 적용한 hash로 판단하여 변경을 건너뛸 수 있다. 새 커밋을 push하고 polling 또는 **Pull and redeploy**로 적용한 뒤 상태를 확인한다. 다음 main 배포는 해당 main의 이미지로 덮어쓰므로 원인 수정도 main에 반영한다.

이미지 복구는 이미 수행된 DB migration을 취소하지 않는다. DB 복원이 필요하면 먼저 쓰기를 중지하고 기존 데이터 복구 절차를 따른다.

## 검증 명령

```bash
python3 -m unittest discover -s tests -p 'test_nas_*.py'
```

이 구성은 별도 NAS 상주 업데이터, Portainer 관리 API 키, NAS의 GitHub 인증정보를 요구하지 않는다.

## 2026-09-08 전환 검증 기록

- [첫 전체 CI](https://github.com/happyaspic-byte/Operix/actions/runs/34246817256)가 성공한 `9e063a3` 이미지를 NAS에서 익명 pull하고 Repository 스택으로 배포했다.
- Portainer 스택 `24`에서 `nas-deploy`의 `232db29` 커밋을 수동 재배포 호출 없이 폴링으로 반영하는 것을 확인했다.
- 배포 후 DB 행 수·볼륨 연결·앱 환경변수·HTTPS 설정이 유지됐으며, 백업·마이그레이션·상태 확인 서비스가 모두 성공했다. 공개 주소와 NAS 주소의 health 및 정적 파일 응답도 확인했다.
- 기존 상주 업데이터 컨테이너·설정 볼륨·전용 API 키를 제거했다. 기존 백업 볼륨은 보존했다.
