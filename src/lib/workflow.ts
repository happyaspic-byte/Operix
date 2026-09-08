import { getDb, type Database, type Row } from "./db";
import { getRecord, saveRecord } from "./records";
import { audit, type User } from "./auth";
import { AppError, requirePermission } from "./policy";
import { lockBusiness } from "./transactions";
export async function workflowFields(
  tx: Database,
  kind: string,
  data: Row,
  previous?: Row,
) {
  if (kind === "assets" && data.lifecycle_status === "retired")
    data.status = "archived";
  if (kind === "customers")
    data.archived_at =
      data.status === "archived" ? previous?.archived_at || new Date() : null;
  if (kind === "tickets") {
    if (!previous) {
      const [p] = await tx.query(
        "SELECT * FROM sla_policies WHERE severity=$1 AND enabled=true",
        [data.severity],
      );
      if (p) {
        const now = Date.now();
        data.response_target_minutes = p.response_minutes;
        data.resolution_target_minutes = p.resolution_minutes;
        data.response_due_at = new Date(now + p.response_minutes * 60000);
        data.resolution_due_at = new Date(now + p.resolution_minutes * 60000);
      }
    }
    if (data.status !== "open" && !previous?.first_response_at)
      data.first_response_at = new Date();
    data.resolved_at = ["resolved", "closed"].includes(data.status)
      ? previous?.resolved_at || new Date()
      : null;
    data.closed_at =
      data.status === "closed" ? previous?.closed_at || new Date() : null;
  }
  if (kind === "customer_contacts" && data.site_id) {
    const [s] = await tx.query("SELECT customer_id FROM sites WHERE id=$1", [
      data.site_id,
    ]);
    if (s?.customer_id !== data.customer_id)
      throw new AppError(400, "선택한 사업장이 해당 고객사에 속하지 않습니다.");
  }
  if (kind === "contracts" && data.predecessor_id) {
    if (previous?.id === data.predecessor_id)
      throw new AppError(400, "자기 자신을 이전 계약으로 지정할 수 없습니다.");
    const [p] = await tx.query(
      "SELECT customer_id FROM contracts WHERE id=$1",
      [data.predecessor_id],
    );
    if (p?.customer_id !== data.customer_id)
      throw new AppError(400, "이전 계약은 같은 고객사에 속해야 합니다.");
    const cycle = previous
      ? await tx.query(
          "WITH RECURSIVE chain AS (SELECT id,predecessor_id FROM contracts WHERE id=$1 UNION SELECT c.id,c.predecessor_id FROM contracts c JOIN chain p ON c.id=p.predecessor_id) SELECT id FROM chain WHERE id=$2",
          [data.predecessor_id, previous.id],
        )
      : [];
    if (cycle.length) throw new AppError(400, "계약 연결에 순환이 생깁니다.");
  }
}
export async function createFollowUp(
  user: User,
  inspectionId: string,
  title: string,
) {
  requirePermission(user.role, "work:write");
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockBusiness(tx);
    const rec = await getRecord("inspections", inspectionId, user, tx);
    if (rec.privacy_erased_at) throw new AppError(410, "파기된 업무입니다.");
    if (
      user.role === "engineer" &&
      rec.assignee_id &&
      rec.assignee_id !== user.id
    )
      throw new AppError(403, "담당 점검의 후속 작업만 만들 수 있습니다.");
    if (rec.follow_up_ticket_id) return { id: rec.follow_up_ticket_id };
    if (rec.status !== "completed" || !rec.follow_up.trim())
      throw new AppError(400, "점검 완료 후 후속 조치 내용을 작성해 주세요.");
    const [asset] = await tx.query(
      "SELECT s.customer_id FROM assets a JOIN sites s ON s.id=a.site_id WHERE a.id=$1",
      [rec.asset_id],
    );
    const t = await saveRecord(
      "tickets",
      user,
      {
        customer_id: asset.customer_id,
        name: title,
        asset_ids: rec.asset_ids,
        description: rec.follow_up,
        assignee_id: user.id,
      },
      undefined,
      tx,
    );
    await tx.query(
      "UPDATE inspections SET follow_up_ticket_id=$2,version=version+1,updated_at=now() WHERE id=$1",
      [rec.id, t.id],
    );
    await audit(tx, user.id, "create_follow_up", "inspections", rec.id, {
      ticket_id: t.id,
    });
    return { id: t.id };
  });
}
