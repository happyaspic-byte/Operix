# Operix v0.2 검증 결과

2026-09-05, 가상 자료로 검증했다. **도메인 63/63·브라우저 16/16 통과**, 실제 PostgreSQL 17·Docker·ClamAV·암호화 백업/복구 검증에 성공했다.

첫 전체 실행: [GitHub Actions #3](https://github.com/happyaspic-byte/Operix/actions/runs/33948162707), 구현 커밋 [288c551](https://github.com/happyaspic-byte/Operix/commit/288c551c01aa4145b9db6ce7713306348f959790). application·container 작업 모두 성공. 당시 최종 구현 검증: [GitHub Actions #8](https://github.com/happyaspic-byte/Operix/actions/runs/33948373808), 커밋 [eb60e1f](https://github.com/happyaspic-byte/Operix/commit/eb60e1f4554812b8a891aacaf635c4cf28b7afda). application·container 모두 성공했으며 KST 표시와 복구 실패 주입 검증을 포함한다. 이어지는 `6c7d5d9`까지는 이 결과 문서를 갱신한 구간이다. 아래 결과·점수·화면은 9월 5일 검증 기록이다.

## 2026-09-08 worktree 통합 검증

통합 기준 `6c7d5d9`에 UI·보안·버그 수정·문서 worktree를 병합한 커밋은 `afdcc78`이다. 후속 테스트 수정까지 포함한 `a696ea7`의 전체 브라우저·API 검증은 새 PostgreSQL 17 앱 DB에서 **33/33 통과**했으며 재시도·건너뜀은 없다. 별도 PostgreSQL 테스트 DB의 단위·DB 검증 **110/110**, 타입 검사·lint·빌드도 통과했다. 앱 구현은 `9ce2966` 이후 바뀌지 않았다.

[통합 기록](INTEGRATION-2026-09-08.md)에 실행별 코드 기준·환경·명령·로컬 결과를 구분한다. 커밋별 원격 결과는 [GitHub Actions](https://github.com/happyaspic-byte/Operix/actions/workflows/ci.yml)에서 확인한다. 개별 worktree의 과거 통과 결과를 합산하거나 9월 5일의 Docker·ClamAV·복구·CI 결과를 새 통합 검증으로 간주하지 않는다.

## 결과와 근거

| 검사 | 결과 | 범위 |
| --- | --- | --- |
| 명시적 타입·정적 검사·운영 빌드 | 통과 | Node 24 / Next 16.3.4 / TypeScript / oxlint |
| 도메인·권한·동시성 | 63/63 | 로컬 PGlite와 GitHub PostgreSQL 17 각각 |
| 브라우저·API | 16/16 | 로컬 운영 빌드 및 PostgreSQL에 연결한 CI Chromium |
| 접근성 자동 검사 | serious·critical 0 | 대시보드/자산/계약/점검/장애 및 문서/일정/계정/설정/접속기록 10개 화면 |
| 운영 의존성 audit | 알려진 취약점 0 | CI 실행 시점 `npm audit --omit=dev --audit-level=moderate` |
| 실제 백신 | 통과 | ClamAV의 정상 파일 clean, EICAR 검사 감염 판정, 다운로드 423 |
| 컨테이너 교체 | 통과 | DB 자료와 인증된 첨부 원본 바이트 유지 |
| 별도 PostgreSQL 복원 | 통과 | 13개 테이블 건수, 보고서 스냅샷, 실제 문서 2건·보고서 1건이 있는 DB |
| 암호화 배포 백업/복원 | 통과 | age 암복호화, 새 파일 볼륨, DB/파일 manifest·SHA-256 확인 |
| 백업 이후 파일·파기 | 통과 | 추가 파일 404, 개인정보 익명화 재적용 및 파기 첨부 410 |
| worker 중단 | 통과 | heartbeat 지연 시 readiness 503 |
| 복구 실패 주입 | 통과 | 다른 스키마 거부, 잘못된 manifest 거부와 쓰기 서비스 정지 유지 |

[로컬 JSON](verification-local.json) · [CI JSON](verification-ci.json) · [점수 산식 JSON](evaluation.json)

CI 아티팩트 `operix-verification`에는 브라우저 결과, 접근성 결과, 화면과 PDF, 조회 지연 결과가 포함되며 14일간 보관한다. 보고서와 장기 참조용 캡처는 저장소에 포함했다. 실제 회사 데이터·운영 키를 사용하지 않았다.

## 재현되는 방어 동작

- 역할에 따른 첨부 목록/다운로드/보고서 차단, 기밀 사유와 1회용 권한, 검사 전 파일 차단.
- 보관 자산·사업장·고객의 계획 정지와 예정 회차 취소, 이미 생성된 계획의 자산 변경 차단.
- 기존 정지 담당자 유지, 신규 비활성 관계 거부, 자산 이동과 계약 연결의 동시 충돌 방지, 중복 worker 실행.
- 잘못된 JSON·페이지 수치의 400, bounded stream·업로드 슬롯·압축 파일 자원 한도.
- 비밀번호 셀프 변경·초기 변경 강제·다른 세션 회수·유휴 만료·백그라운드 갱신 시 유휴 연장 방지.
- 접속기록 서명 변조 탐지·신뢰 IP 처리, 개인정보 보존 예외·미리보기 변경 감지·물리 파일 삭제·DB와 분리된 파기 원장.
- 고객→사업장→자산→계약→점검→확정 보고서, 고객 공개 작업 기록만 출력, 확정 후 원본 변경에도 내용 유지.
- 다중 담당자·SLA 목표 고정/상태 시각·후속 티켓 중복 방지·계약 연결 순환 차단·가져오기 모호성/중복/거래 처리.
- 105건 문서 페이지 경계, 필터와 내보내기 일치, dirty Esc·동시 수정 입력 비교.

## 점수

검증 결과와 개선안 대응 정도를 서로 다른 지표로 제시한다.

| 지표 | 점수 | 산식·의미 |
| --- | --- | --- |
| 자동 회귀 검증 통과율 | **100/100** | (도메인 63 + 브라우저 16) / 79. 실행한 시나리오의 통과율이며 코드 커버리지가 아님 |
| 개선안 대응 점수 | **68.2/100** | (완료 13 + 부분 완료 19 × 0.5) / 33 × 100. 후속 확장 1개는 0 |

대응 점수는 모든 항목에 같은 가중치를 준 진행 추적용 산식이다. 부분 완료의 절반 배점은 평가 규칙일 뿐 작업량의 절반이 끝났다는 측정이 아니다. **보안성·실운영 준비·전사 ERP 완성도·타 제품 순위를 나타내지 않는다.** P0 회사 정책·외부 로그/백업 통제가 남아 있으므로 실자료 투입 승인으로 해석할 수 없다.

v0.1의 주관적 83점 평가는 [과거 기록](history/v0.1/VERIFICATION.md)이다. 이번에는 산식을 공개한 다른 지표를 사용하므로 두 숫자를 직접 비교하지 않는다. [33개 항목별 상태](IMPROVEMENTS-2026-09-05.md)

## 성능 측정 범위

합성 자산 1천 건, 예열된 조건의 순차 서비스 조회 20회에서 최종 CI PostgreSQL p95 **6.34ms**, 최대 **6.87ms**를 기록했다. 로컬 PGlite는 p95 **9.54ms**, 최대 **16.54ms**였다. HTTP 전체 응답·동시 사용자·PDF/대형 첨부·콜드 캐시·메모리 부하의 측정은 아니다.

관계 무결성을 위한 업무 쓰기 전역 잠금이 있으므로 높은 동시 쓰기에서는 처리량이 제한될 수 있다. 실자료 규모의 EXPLAIN, p95·메모리·동시 부하와 비동기 내보내기는 후속 검증 대상이다. 이 수치로 운영 용량이나 타 ERP보다 빠르다는 주장을 하지 않는다.

## 화면 증거

| 화면 | 캡처 |
| --- | --- |
| 대시보드 | [데스크톱](screenshots/dashboard-desktop.jpg) · [모바일](screenshots/dashboard-mobile.jpg) |
| 자산 관리 | [자산](screenshots/assets-desktop.jpg) |
| 문서·보고서 | [문서](screenshots/hardening-documents.jpg) · [확정 보고서](screenshots/report.jpg) |
| 점검 일정 | [월간 일정](screenshots/hardening-calendar.jpg) |
| 계정·세션 | [내 계정](screenshots/hardening-account.jpg) |
| 운영·SLA·개인정보 | [설정](screenshots/hardening-settings.jpg) |
| 접속기록 | [접속기록 점검](screenshots/hardening-security.jpg) |

실제 실행 화면을 Chromium으로 캡처했다. 전체 페이지 이미지에는 반복 테스트가 남긴 가상 자료가 포함될 수 있다. 이미지를 생성하거나 집계 수치를 합성하지 않았다. 화면 캡처의 해시는 로컬 JSON에 기록했다.

실제 HTTPS/VPN·외부 보관/키 복구·MFA/IdP·고객별 개인정보 정책·실규모 부하/RPO/RTO·현장 인수·장문/사진 다페이지·전체 WCAG/화면낭독기·침투 시험은 완료하지 않았다. 외부 법률/보안 인증도 받지 않았다. [운영 절차](DEPLOYMENT.md) · [ERP 비교](COMPARISON.md) · [제3자 고지](../THIRD_PARTY_NOTICES.md)
