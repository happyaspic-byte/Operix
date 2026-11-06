import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "../src/lib/auth.ts";
import { addDays, todayKST } from "../src/lib/dates.ts";
import { overview } from "../src/lib/overview.ts";
import { saveRecord } from "../src/lib/records.ts";
import { isolatedDatabase } from "./helpers/isolated-db.ts";

let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;
const admin: User = {
  id: "expiry-admin",
  email: "expiry@example.test",
  name: "만료 관리자",
  role: "admin",
  active: true,
};

before(async () => {
  fixture = await isolatedDatabase();
  await fixture.db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'test')",
    [admin.id, admin.email, admin.name, admin.role],
  );
});
after(async () => {
  await fixture?.close();
});

test("dashboard separates expired contracts and ranks running ones by remaining days", async () => {
  const today = todayKST();
  const customer = await saveRecord("customers", admin, { name: "만료 고객" });
  const site = await saveRecord("sites", admin, {
    name: "만료 사업장",
    customer_id: customer.id,
  });
  const asset = async (name: string) =>
    (
      await saveRecord("assets", admin, {
        name,
        site_id: site.id,
        product: "everRun",
      })
    ).id;
  const lapsed = await asset("지원 끊긴 자산");
  const renewedElsewhere = await asset("다른 계약으로 유지되는 자산");
  const contract = (name: string, days: number, assetIds: string[]) =>
    saveRecord("contracts", admin, {
      customer_id: customer.id,
      name,
      kind: "maintenance",
      term: "dated",
      end_date: addDays(today, days),
      asset_ids: assetIds,
    });
  // More expired contracts than the old five-row card could show.
  for (let i = 1; i <= 6; i++)
    await contract(`만료 ${i}`, -i, i === 1 ? [lapsed, renewedElsewhere] : []);
  await contract("오늘 만료", 0, []);
  await contract("20일 남음", 20, [renewedElsewhere]);
  await contract("60일 남음", 60, []);
  await contract("200일 남음", 200, []);

  const { expiry } = await overview(admin);
  assert.deepEqual(
    expiry.upcoming.map((c) => c.name),
    ["오늘 만료", "20일 남음", "60일 남음"],
  );
  assert.equal(expiry.upcoming[1].asset_count, 1);
  assert.deepEqual(
    expiry.expired.map((c) => c.name),
    ["만료 1", "만료 2", "만료 3", "만료 4", "만료 5"],
  );
  assert.deepEqual(expiry.counts, {
    expired: 6,
    within30: 2,
    within90: 1,
    expired_assets: 1,
  });
});
