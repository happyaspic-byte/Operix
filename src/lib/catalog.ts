import type { Permission } from "./policy";
export type Field = {
  key: string;
  label: string;
  type?:
    | "text"
    | "textarea"
    | "select"
    | "date"
    | "number"
    | "relation"
    | "assets"
    | "checklist";
  required?: boolean;
  options?: [string, string][];
  entity?: string;
  permission?: Permission;
  min?: number;
  max?: number;
};
export type EntityConfig = {
  title: string;
  singular: string;
  description: string;
  permission: Permission;
  fields: Field[];
  columns: [string, string][];
};
export const stateOptions: [string, string][] = [
  ["normal", "정상"],
  ["warning", "주의"],
  ["critical", "위험"],
  ["unknown", "미확인"],
  ["archived", "보관"],
];
const active: Field = {
  key: "status",
  label: "관리 상태",
  type: "select",
  options: [
    ["active", "관리 중"],
    ["archived", "보관"],
  ],
};
const notes: Field = { key: "notes", label: "메모", type: "textarea" };
const asset: Field = {
  key: "asset_id",
  label: "대상 자산",
  type: "relation",
  entity: "assets",
  required: true,
};
const owner: Field = {
  key: "owner_id",
  label: "내부 담당자",
  type: "relation",
  entity: "users",
};
const assignee: Field = {
  key: "assignee_id",
  label: "담당자",
  type: "relation",
  entity: "users",
};
const protection: Field = {
  key: "protection",
  label: "보호 모드",
  type: "select",
  options: [
    ["unknown", "미확인"],
    ["FT", "FT"],
    ["HA", "HA"],
    ["none", "해당 없음"],
  ],
};
export const catalog: Record<string, EntityConfig> = {
  customers: {
    title: "고객·사업장",
    singular: "고객사",
    description: "고객과 설치 현장의 정보를 한곳에서 관리합니다.",
    permission: "customers:write",
    columns: [
      ["name", "고객사"],
      ["industry", "업종"],
      ["contact_name", "담당자"],
      ["email", "이메일"],
      ["phone", "연락처"],
      ["status", "상태"],
    ],
    fields: [
      { key: "name", label: "고객사명", required: true },
      { key: "industry", label: "업종" },
      { key: "contact_name", label: "고객 담당자" },
      { key: "email", label: "이메일" },
      { key: "phone", label: "연락처" },
      active,
      notes,
    ],
  },
  sites: {
    title: "사업장",
    singular: "사업장",
    description: "설치 장소와 현장 담당자를 관리합니다.",
    permission: "customers:write",
    columns: [
      ["name", "사업장"],
      ["customer_name", "고객사"],
      ["address", "주소"],
      ["contact_name", "현장 담당자"],
      ["status", "상태"],
    ],
    fields: [
      {
        key: "customer_id",
        label: "고객사",
        type: "relation",
        entity: "customers",
        required: true,
      },
      { key: "name", label: "사업장명", required: true },
      { key: "address", label: "주소" },
      { key: "contact_name", label: "현장 담당자" },
      { key: "phone", label: "연락처" },
      active,
      notes,
    ],
  },
  assets: {
    title: "자산 관리",
    singular: "자산",
    description: "설치 구성과 최근 확인 상태를 빠르게 찾아보세요.",
    permission: "assets:write",
    columns: [
      ["name", "자산"],
      ["asset_tag", "자산 ID"],
      ["customer_name", "고객사 / 사업장"],
      ["product", "제품"],
      ["protection", "보호 모드"],
      ["status", "확인 상태"],
      ["observed_at", "최근 확인"],
    ],
    fields: [
      {
        key: "site_id",
        label: "사업장",
        type: "relation",
        entity: "sites",
        required: true,
      },
      { key: "name", label: "자산명", required: true },
      { key: "asset_tag", label: "제조사 자산 ID" },
      {
        key: "product",
        label: "제품",
        type: "select",
        required: true,
        options: [
          ["everRun", "everRun"],
          ["ztC Endurance", "ztC Endurance"],
          ["ztC Edge", "ztC Edge"],
          ["Server", "일반 서버"],
          ["Network", "네트워크"],
          ["Storage", "스토리지"],
        ],
      },
      { key: "model", label: "모델" },
      { key: "software_version", label: "소프트웨어 버전" },
      { key: "serial", label: "시리얼" },
      protection,
      {
        key: "status",
        label: "최근 확인 상태",
        type: "select",
        options: stateOptions,
      },
      owner,
      { key: "observed_at", label: "확인 일자", type: "date" },
      { key: "management_ip", label: "관리 IP", permission: "network" },
      {
        key: "network_notes",
        label: "네트워크 구성",
        type: "textarea",
        permission: "network",
      },
      notes,
    ],
  },
  components: {
    title: "구성요소",
    singular: "구성요소",
    description: "노드와 모듈, 부품의 이력을 관리합니다.",
    permission: "assets:write",
    columns: [
      ["name", "이름"],
      ["role", "역할"],
      ["model", "모델"],
      ["serial", "시리얼"],
      ["status", "상태"],
    ],
    fields: [
      asset,
      { key: "name", label: "이름", required: true },
      { key: "role", label: "역할 (Node0, CMA 등)" },
      { key: "model", label: "모델" },
      { key: "serial", label: "시리얼" },
      { key: "status", label: "상태", type: "select", options: stateOptions },
      notes,
    ],
  },
  vms: {
    title: "가상머신",
    singular: "VM",
    description: "시스템별 VM과 할당 사양을 관리합니다.",
    permission: "assets:write",
    columns: [
      ["name", "VM"],
      ["purpose", "용도"],
      ["os", "운영체제"],
      ["vcpu", "vCPU"],
      ["memory_gb", "메모리 GB"],
      ["protection", "보호 모드"],
    ],
    fields: [
      asset,
      { key: "name", label: "VM 이름", required: true },
      { key: "purpose", label: "용도" },
      { key: "os", label: "운영체제" },
      {
        key: "vcpu",
        label: "vCPU",
        type: "number",
        required: true,
        min: 1,
        max: 4096,
      },
      {
        key: "memory_gb",
        label: "메모리 (GB)",
        type: "number",
        required: true,
        min: 1,
        max: 1048576,
      },
      {
        key: "disk_gb",
        label: "디스크 (GB)",
        type: "number",
        required: true,
        min: 1,
        max: 104857600,
      },
      protection,
      notes,
    ],
  },
  contracts: {
    title: "계약·지원",
    singular: "계약",
    description: "유지보수, 제조사 지원, 사용권을 구분해 관리합니다.",
    permission: "contracts:write",
    columns: [
      ["name", "계약 / 지원"],
      ["customer_name", "고객사"],
      ["kind", "구분"],
      ["end_date", "종료일"],
      ["expiry", "남은 기간"],
      ["renewal", "갱신 상태"],
    ],
    fields: [
      {
        key: "customer_id",
        label: "실제 사용 고객사",
        type: "relation",
        entity: "customers",
        required: true,
      },
      { key: "name", label: "계약명", required: true },
      {
        key: "kind",
        label: "구분",
        type: "select",
        required: true,
        options: [
          ["maintenance", "회사 유지보수"],
          ["vendor_support", "제조사 지원"],
          ["license", "제품 사용권"],
        ],
      },
      { key: "counterparty", label: "계약 상대" },
      { key: "asset_ids", label: "대상 자산", type: "assets" },
      {
        key: "term",
        label: "기간 구분",
        type: "select",
        required: true,
        options: [
          ["dated", "기간 지정"],
          ["unknown", "미확인"],
          ["perpetual", "무기한"],
        ],
      },
      { key: "start_date", label: "시작일", type: "date" },
      { key: "end_date", label: "종료일", type: "date" },
      {
        key: "renewal",
        label: "갱신 진행",
        type: "select",
        options: [
          ["not_started", "미진행"],
          ["contacted", "협의 중"],
          ["quoted", "견적 전달"],
          ["renewed", "갱신 완료"],
          ["ended", "종료"],
        ],
      },
      owner,
      {
        key: "amount",
        label: "계약 금액 (원)",
        type: "number",
        min: 0,
        max: 999999999999999,
        permission: "money",
      },
      active,
      notes,
    ],
  },
  maintenance_plans: {
    title: "반복 점검 계획",
    singular: "반복 계획",
    description: "회차별 기록이 생성되는 정기 점검 계획입니다.",
    permission: "work:write",
    columns: [
      ["name", "계획"],
      ["asset_name", "대상 자산"],
      ["start_date", "첫 점검일"],
      ["interval_months", "주기 (월)"],
      ["status", "상태"],
    ],
    fields: [
      asset,
      { key: "name", label: "계획명", required: true },
      { key: "start_date", label: "첫 점검일", type: "date", required: true },
      {
        key: "interval_months",
        label: "주기 (월)",
        type: "select",
        options: [
          ["1", "매월"],
          ["3", "분기"],
          ["6", "반기"],
          ["12", "매년"],
        ],
        required: true,
      },
      assignee,
      { key: "checklist", label: "점검 항목", type: "checklist" },
      active,
    ],
  },
  inspections: {
    title: "점검·일정",
    singular: "점검",
    description: "예정된 점검과 현장 작업 결과를 이어서 관리합니다.",
    permission: "work:write",
    columns: [
      ["name", "점검"],
      ["asset_name", "대상 자산"],
      ["customer_name", "고객사"],
      ["planned_date", "예정일"],
      ["assignee_name", "담당자"],
      ["status", "진행 상태"],
    ],
    fields: [
      asset,
      { key: "name", label: "점검명", required: true },
      { key: "planned_date", label: "예정일", type: "date", required: true },
      assignee,
      {
        key: "status",
        label: "진행 상태",
        type: "select",
        options: [
          ["scheduled", "예정"],
          ["in_progress", "진행 중"],
          ["completed", "완료"],
          ["cancelled", "취소"],
        ],
      },
      { key: "checklist", label: "점검 항목", type: "checklist" },
      { key: "result", label: "점검 결과", type: "textarea" },
      { key: "follow_up", label: "후속 조치", type: "textarea" },
    ],
  },
  tickets: {
    title: "장애·작업",
    singular: "작업",
    description: "접수부터 해결까지, 모든 조치와 근거를 기록합니다.",
    permission: "work:write",
    columns: [
      ["name", "장애 / 작업"],
      ["customer_name", "고객사"],
      ["severity", "우선순위"],
      ["status", "상태"],
      ["assignee_name", "담당자"],
      ["vendor_case", "벤더 케이스"],
    ],
    fields: [
      {
        key: "customer_id",
        label: "고객사",
        type: "relation",
        entity: "customers",
        required: true,
      },
      { key: "name", label: "제목", required: true },
      { key: "asset_ids", label: "관련 자산", type: "assets" },
      {
        key: "severity",
        label: "우선순위",
        type: "select",
        options: [
          ["medium", "보통"],
          ["low", "낮음"],
          ["high", "높음"],
          ["critical", "긴급"],
        ],
      },
      {
        key: "status",
        label: "상태",
        type: "select",
        options: [
          ["open", "접수"],
          ["in_progress", "진행 중"],
          ["waiting", "대기"],
          ["resolved", "해결"],
          ["closed", "종결"],
        ],
      },
      assignee,
      { key: "description", label: "증상 / 요청 내용", type: "textarea" },
      { key: "vendor_case", label: "벤더 케이스 번호" },
      {
        key: "evidence_level",
        label: "근거 구분",
        type: "select",
        options: [
          ["observed", "관찰 사실"],
          ["internal", "내부 추정"],
          ["vendor", "제조사 확인"],
        ],
      },
      { key: "resolution", label: "조치 결과", type: "textarea" },
    ],
  },
};
export const labels: Record<string, string> = {
  active: "관리 중",
  archived: "보관",
  normal: "정상",
  warning: "주의",
  critical: "긴급",
  unknown: "미확인",
  scheduled: "예정",
  in_progress: "진행 중",
  completed: "완료",
  cancelled: "취소",
  open: "접수",
  waiting: "대기",
  resolved: "해결",
  closed: "종결",
  maintenance: "회사 유지보수",
  vendor_support: "제조사 지원",
  license: "제품 사용권",
  not_started: "미진행",
  contacted: "협의 중",
  quoted: "견적 전달",
  renewed: "갱신 완료",
  ended: "종료",
  medium: "보통",
  high: "높음",
  low: "낮음",
  observed: "관찰 사실",
  internal: "내부 추정",
  vendor: "제조사 확인",
  perpetual: "무기한",
  dated: "기간 지정",
  none: "해당 없음",
};

catalog.customer_contacts = {
  title: "고객 연락처",
  singular: "고객 담당자",
  description: "고객사와 사업장의 기술·계약·청구 담당자를 관리합니다.",
  permission: "customers:write",
  columns: [
    ["name", "이름"],
    ["customer_name", "고객사"],
    ["contact_role", "역할"],
    ["email", "이메일"],
    ["phone", "연락처"],
    ["status", "상태"],
  ],
  fields: [
    {
      key: "customer_id",
      label: "고객사",
      type: "relation",
      entity: "customers",
      required: true,
    },
    { key: "site_id", label: "사업장", type: "relation", entity: "sites" },
    { key: "name", label: "이름", required: true },
    { key: "department", label: "부서" },
    {
      key: "contact_role",
      label: "연락 역할",
      type: "select",
      options: [
        ["technical", "기술 담당"],
        ["contract", "계약 담당"],
        ["billing", "청구 담당"],
        ["other", "기타"],
      ],
    },
    { key: "email", label: "이메일" },
    { key: "phone", label: "연락처" },
    active,
    notes,
  ],
};
catalog.contracts.fields.push(
  {
    key: "predecessor_id",
    label: "이전 계약",
    type: "relation",
    entity: "contracts",
  },
  {
    key: "notice_days",
    label: "사전 알림 시작 (일)",
    type: "number",
    min: 1,
    max: 365,
  },
);
catalog.assets.fields.push(
  { key: "eol_date", label: "EOL (판매 종료일)", type: "date" },
  { key: "eos_date", label: "EOS (지원 종료일)", type: "date" },
  {
    key: "lifecycle_status",
    label: "자산 생애주기",
    type: "select",
    options: [
      ["operating", "운영 중"],
      ["replacement_planned", "교체 계획"],
      ["retired", "철수"],
    ],
  },
);
Object.assign(labels, {
  technical: "기술 담당",
  contract: "계약 담당",
  billing: "청구 담당",
  other: "기타",
  operating: "운영 중",
  replacement_planned: "교체 계획",
  retired: "철수",
});
