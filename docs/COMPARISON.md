# ERP 비교: Operix · ERPNext · Odoo · 이카운트

비교는 공식 기능 문서와 Operix의 구현·테스트 결과를 구분해 작성했다. 타 제품을 설치하거나 동일 조건으로 성능 시험한 결과는 아니다. 제품 에디션·설정·확장 모듈에 따라 실제 지원 범위가 달라진다.

| 비교 항목        | Operix v0.2                                       | ERPNext                                        | Odoo                                           | 이카운트                                                   |
| ---------------- | ------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| 주된 방향        | 사내 고객·설치 자산·유지보수 업무                 | 회계·재고·구매·서비스를 포함한 ERP             | 업무별 앱을 조합하는 ERP                       | 국내 재고·영업·회계·급여 업무                              |
| 유지보수 흐름    | 점검·장애·후속 티켓·SLA·주월 일정·확정 보고서                   | Maintenance Visit, Schedule, Asset Maintenance | Maintenance, Field Service, Helpdesk 관련 기능 | CRM과 거래 기록 연계, 전용 현장 점검 범위는 추가 확인 필요 |
| 장비 구조        | 시스템·Node0/Node1 또는 CMA/CMB·VM 연결           | 일반 자산 구조에 장비 계층 추가 설계 검토      | Equipment와 필드 서비스 구조에 추가 설계 검토  | 품목·CRM 기준의 적합성 및 추가 항목 검토                   |
| 계약·지원·사용권 | 세 종류를 구분하고 자산 연결·만료 알림 제공       | 실제 유지보수 계약 운영에 맞는 설정 검토       | 설치 모듈과 계약 업무 흐름에 맞는 설정 검토    | 거래처·계약 파일·거래 이력 활용                            |
| 영업·구매·회계   | 후속 개발 범위                                    | 관련 ERP 기능 제공                             | 관련 앱 제공                                   | 관련 기능 제공                                             |
| 실무 맞춤 변경   | 이 저장소에서 직접 변경                           | 확장·개발과 운영 역량 필요                     | 에디션·호스팅에 따른 확장 정책 확인            | 제공되는 항목·보고서 설정 범위 활용                        |
| 현재 검증 수준   | 이번 테스트와 가상 자료 검증, 사내 실자료 검증 전 | 이번 작업에서 제품 운영 시험 미실시            | 이번 작업에서 제품 운영 시험 미실시            | 이번 작업에서 제품 운영 시험 미실시                        |

장비 계층에 관한 ‘추가 설계 검토’는 공개 기능 문서를 바탕으로 한 설계 판단이며 해당 제품에서 구현 불가능하다는 의미가 아니다.

현재 선택한 범위에는 Operix의 고객·장비·지원 이력 연결이 직접 맞는다. 견적·매입·매출·급여까지 바로 실사용해야 한다면 기성 ERP의 기존 기능과 연계를 함께 검토하는 편이 유리하다. Operix가 성숙한 전사 ERP 전체를 대체한다고 평가하지 않는다.

ERPNext는 유지보수 방문·반복 작업과 회차별 로그를 제공한다. [Maintenance Visit](https://docs.frappe.io/erpnext/maintenance-visit), [Asset Maintenance](https://docs.frappe.io/erpnext/asset-maintenance), [Service Organization](https://docs.frappe.io/erpnext/erpnext-for-services-organization)

Odoo는 장비 예방·교정 유지보수, 현장 작업 생성과 작업 기록 양식을 문서화한다. [Maintenance setup](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/maintenance/maintenance_setup.html), [Field service tasks](https://www.odoo.com/documentation/19.0/applications/services/field_service/creating_tasks.html), [Worksheets](https://www.odoo.com/documentation/19.0/applications/services/field_service/worksheets.html)

이카운트는 재고·회계·영업 기능과 고객·계약 파일·전표의 연계를 제공한다. [ERP 기능](https://www.ecount.com/kr/ecount/product/erp_features), [고객관리](https://www.ecount.com/kr/ecount/product/groupware_crm), [업무 범위](https://www.ecount.com/kr/ecount/trial/suitable-erp-for-fast-growing-businesses)


## 이번 개선 후에도 남는 비교 차이

| 항목 | Operix v0.2 | 기성 ERP와 비교할 때 확인할 점 |
| --- | --- | --- |
| 서비스 목표 | 우선순위별 24시간 경과 SLA, 생성 시 목표 고정, 상태/응답/해결 기록 | 고객별 정책·근무시간·지원 팀·보고서까지 실제 계약으로 비교 |
| 개인정보/보안 | 문서 등급, 격리 검사, 파기·복원 연계, 접속기록, 유휴 세션 | IdP/MFA·외부 보관·권한 관리·회사 운영 절차를 함께 평가 |
| 이관·확장 | 고객/사업장/자산/계약 가져오기 및 자체 코드 변경 | 관계 전체 이관·실사용 데이터 정리·업그레이드 유지 비용 |
| 전사 ERP | 유지보수 중심, 회계/급여/재고는 미구현 | 기성 ERP의 해당 모듈과 연동 또는 도입 범위를 별도 결정 |

Odoo의 Helpdesk 문서는 SLA 정책을 지원 팀·목표 등으로 구성하고 근무시간에 따른 기한을 설명한다. Operix의 현재 SLA는 이보다 단순한 24시간 경과 기준이다. [Odoo SLA](https://www.odoo.com/documentation/19.0/applications/services/helpdesk/overview/sla.html)

이번 자체 점수는 Operix 구현·검증 범위의 평가다. 다른 ERP의 보안성/성능/비용을 실제로 측정하지 않았으므로 경쟁 제품 점수나 순위를 만들지 않았다. 가격은 이번 비교에서 조사하지 않았다.
