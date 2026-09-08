# GitHub main → NAS 자동배포

`main`에 push하면 기존 `Operix verification`의 애플리케이션·컨테이너 검증을 수행한다. 모두 성공한 커밋의 **실제 검증한 Docker 이미지**를 GitHub Release에 게시하고 `nas-deploy/manifest.json`을 갱신한다. NAS의 `operix-auto-update` 컨테이너가 60초 간격으로 이 포인터를 확인한다. 반영 시간은 CI·이미지 전송·기동 시간에 따라 달라진다.

```text
main push → application + container 성공
          → 이미지·체크섬을 immutable Release로 게시
          → nas-deploy 포인터 갱신
          → NAS 다운로드·검증·DB 백업·앱 교체·readiness 확인
```

PR 및 다른 브랜치는 운영에 배포하지 않는다. 새 커밋이 main에 추가되면 이전 커밋의 배포를 건너뛴다. NAS는 고정된 저장소, CI workflow, main SHA, Release tag, 이미지 ID와 압축 파일 크기·SHA-256을 대조한다. 배포 파일에는 소스의 실행 이미지와 메타데이터만 포함된다. 운영 `.env`, 데이터, 자격증명은 CI로 전달하지 않는다.

## 운영 스택 보존

이 설치는 Portainer의 기존 JSON 형식 Compose를 그대로 사용한다. 스택 환경변수 `OPERIX_IMAGE`만 새 고유 태그로 변경한다. `migrate`, `web`, `worker`가 이 변수로 같은 이미지를 사용해야 한다. 기존 DB·첨부·보안 로그·스캐너 볼륨, 프록시 네트워크 및 HTTPS 구성은 현재 스택에서 읽는다. 루트 `compose.yaml`을 운영 스택에 덮어쓰지 않는다.

업데이터는 Docker 소켓을 직접 마운트하지 않는다. NAS의 host 네트워크에서 `127.0.0.1:9000` Portainer API로 통신한다. 외부 요청을 받는 서버·포트는 만들지 않는다. NAS에는 GitHub 토큰이 필요 없고, GitHub에서 NAS로 들어오는 포트도 추가하지 않는다. Portainer API 키는 읽기 전용 private 볼륨 파일에 보관한다. 해당 키에는 배포 대상 환경·스택을 관리할 권한이 필요하므로 접근을 제한하고 Portainer에서 별도로 회수할 수 있도록 전용 키를 사용한다.

## 설치와 업데이터 코드 갱신

관리자 PC에서 저장소를 받고, 저장소 밖의 접근 제한 디렉터리에 `config.example.json` 복사본과 Portainer API 키 파일을 준비한다. 구성의 스택·환경·저장소·workflow ID와 실제 HTTPS health URL을 확인한다. 두 파일은 Git에 넣지 않는다. Python 3.13 이상을 사용한다.

NAS에 Python 실행 이미지를 먼저 pull하고 해당 이미지의 **실제 digest**를 설치 인수로 사용한다. 설치 도구는 기존 다른 이미지·볼륨·스택을 제거하지 않는다. 아래 경로와 주소는 설치 환경에 맞춘다.

```bash
chmod 700 /secure/operix-deploy
chmod 600 /secure/operix-deploy/config.json /secure/operix-deploy/api-key
python3 deploy/nas-auto-update/install.py \
  --portainer-url http://nas.example.internal:9000 \
  --config /secure/operix-deploy/config.json \
  --key-file /secure/operix-deploy/api-key \
  --runtime-image python@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a
```

자체 서명 HTTPS 인증서가 있는 NAS는 고정 설정에 `health_ca: "/config/health-ca.pem"`을 지정하고 설치 명령에 `--health-ca /secure/operix-deploy/health-ca.pem`을 추가한다. 실제 운영 인증서의 공개 인증서 파일을 사용하며 인증서·호스트 이름 검증을 끄지 않는다. host 네트워크 모드에서는 NAS의 기존 HTTPS 접근 제어를 바꿀 필요가 없다.

기존 업데이터의 검토한 코드를 갱신할 때는 같은 명령에 `--replace`를 추가한다. 업데이터 자체 코드는 앱 배포로 바뀌지 않는다. 교체 전에 진행 중인 배포가 없는지 상태·로그를 확인한다. 설치는 다음 리소스를 사용한다.

| 리소스 | 용도 |
| --- | --- |
| `operix-auto-update` | 비 root, 읽기 전용 root 파일시스템, 512MiB 제한, 재시작 정책 `unless-stopped` |
| `operix-auto-update-config` | API 키·고정 대상 설정·검토한 updater 코드, 컨테이너에서 읽기 전용 |
| `operix-auto-update-state` | 마지막 배포 상태, 진행 중 트랜잭션, private 설정 스냅샷과 DB 백업 |
| 네트워크 | NAS는 `host` 모드와 loopback API 사용. `bridge` 모드를 선택하면 전용 `operix-deploy-control` 네트워크 사용 |

## 상태 확인과 중지

Portainer에서 `operix-auto-update`의 로그를 확인한다. GitHub의 Actions 실행, `deploy-<전체 SHA>` Release 및 `nas-deploy` 브랜치에서 게시 상태를 확인할 수 있다. 배포 상태 파일에는 성공한 SHA와 실패한 SHA가 기록된다. Docker 명령을 사용할 수 있는 NAS 셸에서는 다음과 같이 확인한다.

```bash
docker logs --tail=80 operix-auto-update
docker exec operix-auto-update cat /state/state.json
docker inspect --format '{{.Config.Image}}' operix-web-1
```

자동 갱신을 멈추려면 Portainer에서 업데이터 컨테이너만 Stop한다. 현재 Operix 서비스는 계속 실행된다. NAS 재시작 이후에도 정지 상태를 유지하려면 해당 컨테이너의 재시작 정책을 `no`로 바꾼다. 키를 회수하려면 Portainer의 계정 API 토큰 설정에서 전용 키를 삭제한다.

## 실패와 복구

배포 전에 기존 Compose와 전체 환경변수, 컨테이너·볼륨 연결 정보를 접근 제한 상태 디렉터리에 저장하고 PostgreSQL custom-format dump를 만든다. 앱 교체 실패 시 이전 이미지를 다시 적용한다. 일시 통신 오류·GitHub 호출 제한·아직 완료되지 않은 CI는 대기 후 다시 확인한다. 실제 배포 실패 또는 영구 검증 실패로 기록한 SHA는 자동으로 반복 적용하지 않는다. 복구 자체가 실패하면 새 배포를 중단하고 상태·로그에 남긴다.

**이미지 복구는 DB 복구가 아니다.** SQL migration은 이미 반영됐을 수 있으므로 기존 앱과 호환되는 방식으로 작성해야 한다. 배포 전 DB dump는 운영 데이터가 들어 있는 NAS 로컬 복구 자료다. 첨부파일까지 같은 시점으로 보관하는 암호화 백업·외부 복제는 [운영·복구 절차](../../docs/DEPLOYMENT.md)의 별도 절차를 따른다. 업데이터가 DB를 오래된 dump로 자동 되돌리지는 않는다.

운영자가 수동으로 이미지를 바꾸거나 DB를 복구하기 전에는 업데이터를 먼저 멈춘다. 원인 수정 커밋을 main에 push하면 새 SHA로 검증·배포할 수 있다. 기존 이미지는 자동 삭제하지 않으므로 NAS 저장 공간을 관리하면서 현재/이전 이미지를 식별해 보관한다.

## 검증

```bash
python3 -m unittest discover -s tests -p 'test_nas_*.py'
```

계약 테스트는 잘못된 메타데이터·실패한 CI·체크섬 불일치·이미지 로드 오류·환경변수 유실·실패 재시도·복구 동작을 검증한다. 실제 NAS 배포 여부는 테스트 통과와 별도로 실행 중인 이미지 ID, migrate 종료 코드, web/worker 상태와 HTTPS readiness에서 확인한다.
