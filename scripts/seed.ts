import { createHash } from "node:crypto";
import { getDb } from "../src/lib/db.ts";
import { hashPassword } from "../src/lib/auth.ts";
import { todayKST, addDays } from "../src/lib/dates.ts";
import { runJobs } from "../src/lib/jobs.ts";
const id = (s: string) => {
  const h = createHash("sha256")
    .update("operix-demo:" + s)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const db = await getDb();
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase(),
  password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 12)
  throw new Error(
    "Set ADMIN_EMAIL and a unique ADMIN_PASSWORD of 12+ characters before seeding.",
  );
const hash = await hashPassword(password),
  adminId = id("admin");
await db.query(
  "INSERT INTO users(id,email,name,role,password_hash,must_change_password) VALUES ($1,$2,'관리자','admin',$3,$4) ON CONFLICT(email) DO NOTHING",
  [
    adminId,
    email,
    hash,
    ![
      process.env.CI === "true",
      process.env.OPERIX_EMBEDDED === "1",
      process.env.OPERIX_CONTAINER_TEST === "1",
    ].some(Boolean),
  ],
);
const [admin] = await db.query("SELECT * FROM users WHERE email=$1", [email]);
if (process.env.SEED_DEMO === "1") {
  const demoPassword = process.env.DEMO_PASSWORD;
  if (!demoPassword || demoPassword.length < 12)
    throw new Error("Set DEMO_PASSWORD (12+ characters) for synthetic users.");
  const demoHash = await hashPassword(demoPassword);
  const staff = [
    ["manager", "김현우", "manager"],
    ["engineer", "이서준", "engineer"],
    ["sales", "박지민", "sales"],
    ["viewer", "정유진", "viewer"],
  ];
  for (const [key, name, role] of staff)
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [id(key), `${key}@operix.test`, name, role, demoHash],
    );
  const today = todayKST();
  await db.transaction(async (tx) => {
    const customers = [
      ["한빛모빌리티", "자동차 부품", "이민재"],
      ["다온로지스", "물류·운송", "한소연"],
      ["새롬반도체", "반도체", "김도윤"],
      ["오름에너지", "에너지", "윤서영"],
      ["푸른데이터", "IT 서비스", "최현준"],
    ];
    for (let i = 0; i < customers.length; i++) {
      const [name, industry, contact] = customers[i];
      await tx.query(
        "INSERT INTO customers(id,name,industry,contact_name,email,phone,notes) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        [
          id("customer" + i),
          name,
          industry,
          contact,
          `contact${i}@example.com`,
          "02-0000-0000",
          "가상 예제 데이터 · 실제 고객 정보가 아닙니다.",
        ],
      );
    }
    const sites = [
      ["창원 생산센터", 0, "경상남도 창원시 (가상 주소)"],
      ["부산 물류센터", 1, "부산광역시 강서구 (가상 주소)"],
      ["이천 공정센터", 2, "경기도 이천시 (가상 주소)"],
      ["진천 발전운영센터", 3, "충청북도 진천군 (가상 주소)"],
      ["서울 데이터센터", 4, "서울특별시 (가상 주소)"],
      ["광명 생산센터", 0, "경기도 광명시 (가상 주소)"],
    ];
    for (let i = 0; i < sites.length; i++) {
      const [name, c, address] = sites[i];
      await tx.query(
        "INSERT INTO sites(id,customer_id,name,address,contact_name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [id("site" + i), id("customer" + c), name, address, "현장 담당자"],
      );
    }
    const assets = [
      ["MES-DB", 0, "everRun", "ProLiant DL380", "normal", "FT"],
      ["ASRS-DB", 1, "everRun", "PowerEdge R750", "warning", "FT"],
      [
        "공정 제어 서버",
        2,
        "ztC Endurance",
        "Endurance 3110",
        "normal",
        "none",
      ],
      ["모니터링 서버", 3, "ztC Edge", "Edge 250i", "normal", "HA"],
      ["ERP-APP", 4, "Server", "ThinkSystem SR650", "normal", "none"],
      ["RCP-Control", 1, "everRun", "ProLiant DL380", "critical", "FT"],
      [
        "생산 이력 서버",
        5,
        "ztC Endurance",
        "Endurance 5110",
        "normal",
        "none",
      ],
      ["품질 검사 서버", 0, "ztC Edge", "Edge 250i", "normal", "FT"],
      ["백업 스토리지", 4, "Storage", "RackStation", "normal", "none"],
      ["설비 데이터 수집", 3, "Server", "PowerEdge R450", "unknown", "none"],
      ["WMS-DB", 1, "everRun", "PowerEdge R750", "normal", "FT"],
      [
        "공정 분석 서버",
        2,
        "ztC Endurance",
        "Endurance 3110",
        "normal",
        "none",
      ],
    ];
    for (let i = 0; i < assets.length; i++) {
      const [name, site, product, model, status, protection] = assets[i];
      const tag =
        "DEMO-" + (product === "ztC Endurance" ? "zen-" : "ee-") + (10001 + i);
      await tx.query(
        "INSERT INTO assets(id,site_id,name,asset_tag,product,model,software_version,serial,protection,status,owner_id,management_ip,network_notes,observed_at,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING",
        [
          id("asset" + i),
          id("site" + site),
          name,
          tag,
          product,
          model,
          "예제 버전",
          "DEMO-SN-" + (i + 1),
          protection,
          status,
          id("engineer"),
          "192.0.2." + (i + 10),
          "문서용 예시 주소 (RFC 5737)",
          status === "unknown" ? null : addDays(today, -(i % 4)),
          "가상 데이터. 실제 사양·제품 권장 구성을 나타내지 않습니다.",
        ],
      );
      if (["everRun", "ztC Edge", "ztC Endurance"].includes(String(product)))
        for (const part of product === "ztC Endurance"
          ? ["CMA", "CMB"]
          : ["Node0", "Node1"])
          await tx.query(
            "INSERT INTO components(id,asset_id,name,role,model,serial,status) VALUES ($1,$2,$3,$3,$4,$5,'normal') ON CONFLICT DO NOTHING",
            [
              id("part" + i + part),
              id("asset" + i),
              part,
              model,
              "DEMO-" + i + "-" + part,
            ],
          );
      if (["everRun", "ztC Edge"].includes(String(product)))
        await tx.query(
          "INSERT INTO vms(id,asset_id,name,purpose,os,vcpu,memory_gb,disk_gb,protection) VALUES ($1,$2,$3,'업무 데이터베이스','Windows Server',8,32,500,$4) ON CONFLICT DO NOTHING",
          [id("vm" + i), id("asset" + i), String(name) + "-VM", protection],
        );
    }
    const contracts = [
      ["2026 시스템 유지보수", 0, 0, "maintenance", 30, "contacted"],
      ["물류 시스템 제조사 지원", 1, 1, "vendor_support", 12, "quoted"],
      ["공정 서버 제조사 지원", 2, 2, "vendor_support", 65, "not_started"],
      ["에너지 플랫폼 유지보수", 3, 3, "maintenance", 88, "not_started"],
      ["데이터센터 유지보수", 4, 4, "maintenance", 180, "not_started"],
      ["물류 RCP 유지보수", 1, 5, "maintenance", -5, "contacted"],
    ];
    for (let i = 0; i < contracts.length; i++) {
      const [name, customer, a, kind, days, renewal] = contracts[i];
      await tx.query(
        "INSERT INTO contracts(id,customer_id,name,kind,counterparty,start_date,end_date,term,renewal,owner_id,amount) VALUES ($1,$2,$3,$4,$5,$6,$7,'dated',$8,$9,$10) ON CONFLICT DO NOTHING",
        [
          id("contract" + i),
          id("customer" + customer),
          name,
          kind,
          "예제 계약 상대",
          addDays(today, -180),
          addDays(today, Number(days)),
          renewal,
          id("sales"),
          (i + 1) * 1200000,
        ],
      );
      await tx.query(
        "INSERT INTO contract_assets(contract_id,asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [id("contract" + i), id("asset" + a)],
      );
    }
    await tx.query(
      "INSERT INTO contracts(id,customer_id,name,kind,term,renewal) VALUES ($1,$2,'업무 시스템 영구 사용권','license','perpetual','not_started') ON CONFLICT DO NOTHING",
      [id("perpetual"), id("customer0")],
    );
    await tx.query(
      "INSERT INTO contract_assets(contract_id,asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [id("perpetual"), id("asset0")],
    );
    const checklist = [
      { label: "시스템 상태 및 경고 확인", checked: false },
      { label: "이중화 구성 상태 확인", checked: false },
      { label: "백업 결과 및 여유 공간 확인", checked: false },
    ];
    for (let i = 0; i < 8; i++) {
      const days = [-3, 1, 2, 4, 7, -32, -61, -92][i],
        complete = i >= 5;
      await tx.query(
        "INSERT INTO inspections(id,asset_id,name,planned_date,assignee_id,status,checklist,result,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
        [
          id("inspection" + i),
          id("asset" + i),
          [
            "물류센터 정기 점검",
            "ASRS 시스템 정기 점검",
            "공정 서버 예방 점검",
            "에너지 플랫폼 점검",
            "데이터센터 정기 점검",
            "물류 RCP 정기 점검",
            "생산 시스템 점검",
            "품질 시스템 점검",
          ][i],
          addDays(today, days),
          id("engineer"),
          complete ? "completed" : i === 0 ? "in_progress" : "scheduled",
          JSON.stringify(checklist.map((c) => ({ ...c, checked: complete }))),
          complete
            ? "가상 점검 결과: 시스템 상태와 이중화 구성을 확인했습니다."
            : "",
          complete ? new Date(addDays(today, days)) : null,
        ],
      );
    }
    const tickets = [
      ["RCP 메모리 동기화 상태 확인", 1, 5, "high", "in_progress"],
      ["지원 기간 갱신 사양 검토", 1, 1, "medium", "waiting"],
      ["정기 백업 결과 확인 요청", 4, 8, "medium", "open"],
      ["공정 서버 구성 자료 갱신", 2, 2, "low", "in_progress"],
    ];
    for (let i = 0; i < tickets.length; i++) {
      const [name, c, a, severity, status] = tickets[i];
      await tx.query(
        "INSERT INTO tickets(id,customer_id,name,severity,status,assignee_id,description,vendor_case,evidence_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'observed') ON CONFLICT DO NOTHING",
        [
          id("ticket" + i),
          id("customer" + c),
          name,
          severity,
          status,
          id("engineer"),
          "가상 예제 요청입니다. 최근 상태와 증빙을 확인하고 후속 조치를 기록합니다.",
          "DEMO-CS-" + (100 + i),
        ],
      );
      await tx.query(
        "INSERT INTO ticket_assets(ticket_id,asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [id("ticket" + i), id("asset" + a)],
      );
    }
    await tx.query(
      "INSERT INTO entries(id,entity_kind,entity_id,user_id,body,evidence_level) VALUES ($1,'tickets',$2,$3,'최근 확인 기록을 검토했습니다. 추가 진단 자료 확보 후 원인을 확인할 예정입니다.','observed') ON CONFLICT DO NOTHING",
      [id("entry0"), id("ticket0"), id("engineer")],
    );
    await tx.query(
      "INSERT INTO maintenance_plans(id,asset_id,name,start_date,interval_months,assignee_id,checklist) VALUES ($1,$2,'분기 예방 점검',$3,3,$4,$5) ON CONFLICT DO NOTHING",
      [
        id("plan0"),
        id("asset0"),
        addDays(today, 15),
        id("engineer"),
        JSON.stringify(checklist),
      ],
    );
    for (let i = 0; i < 4; i++)
      await tx.query(
        "INSERT INTO audit_logs(id,user_id,action,entity_kind,entity_id,details) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [
          id("audit" + i),
          i % 2 ? admin.id : id("engineer"),
          i % 2 ? "create" : "update",
          i % 2 ? "customers" : "assets",
          id(i % 2 ? "customer0" : "asset0"),
          JSON.stringify({ source: "synthetic demo seed" }),
        ],
      );
  });
  await runJobs();
  console.log(
    "Synthetic demonstration data seeded. No real customer data was used.",
  );
}
console.log(
  "Administrator bootstrap completed; existing credentials were preserved.",
);
await db.close();
