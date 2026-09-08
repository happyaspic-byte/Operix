import { getDb } from "./db";
import { lockBusiness } from "./transactions";
import { todayKST, dayDiff, recurringDate, addDays } from "./dates";
export async function runJobs(today = todayKST()) {
  const db = await getDb();
  try {
    return await db.transaction(async (tx) => {
      await tx.query("SET LOCAL statement_timeout='30s'");
      await tx.query("SET LOCAL lock_timeout='10s'");
      const locked = await tx.query(
        "SELECT id FROM job_runs WHERE id='scheduler' FOR UPDATE SKIP LOCKED",
      );
      if (!locked.length) return { created: 0, notified: 0, skipped: true };
      await lockBusiness(tx);
      await tx.query("SET LOCAL statement_timeout='30s'");
      let created = 0,
        notified = 0;
      const plans = await tx.query(
        "SELECT p.*,CASE WHEN ass.active THEN p.assignee_id ELSE NULL END effective_assignee_id FROM maintenance_plans p LEFT JOIN users ass ON ass.id=p.assignee_id JOIN assets a ON a.id=p.asset_id JOIN sites s ON s.id=a.site_id JOIN customers c ON c.id=s.customer_id WHERE p.status='active' AND a.status<>'archived' AND s.status='active' AND c.status='active'",
      );
      for (const plan of plans) {
        let index = plan.next_index;
        const horizon = addDays(today, 30);
        for (let guard = 0; guard < 1200; guard++) {
          const date = recurringDate(
            plan.start_date,
            plan.interval_months,
            index,
          );
          if (date > horizon) break;
          const rows = await tx.query(
            "INSERT INTO inspections(id,asset_id,plan_id,name,planned_date,assignee_id,checklist) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(plan_id,planned_date) DO NOTHING RETURNING id",
            [
              crypto.randomUUID(),
              plan.asset_id,
              plan.id,
              plan.name,
              date,
              plan.effective_assignee_id,
              JSON.stringify(
                plan.checklist.map((c: any) => ({ ...c, checked: false })),
              ),
            ],
          );
          for (const row of rows)
            await tx.query(
              "INSERT INTO inspection_assets(inspection_id,asset_id) VALUES ($1,$2)",
              [row.id, plan.asset_id],
            );
          created += rows.length;
          index++;
        }
        await tx.query(
          "UPDATE maintenance_plans SET next_index=$2 WHERE id=$1",
          [plan.id, index],
        );
      }
      await tx.query(
        "DELETE FROM notifications n WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id=n.user_id AND u.active=true)",
      );
      const managers = await tx.query(
        "SELECT id FROM users WHERE active=true AND role IN ('admin','manager')",
      );
      const contracts = await tx.query(
        "SELECT * FROM contracts WHERE status='active' AND term='dated' AND renewal NOT IN ('renewed','ended')",
      );
      for (const c of contracts) {
        const days = dayDiff(c.end_date, today);
        const bucket =
          days < 0
            ? -1
            : [...new Set([0, 7, 30, 60, 90, c.notice_days])]
                .sort((a, b) => a - b)
                .find((n) => days <= n);
        if (bucket === undefined || days > c.notice_days) continue;
        const users = [
          ...new Set([
            ...managers.map((u) => u.id),
            ...(c.owner_id &&
            (
              await tx.query(
                "SELECT id FROM users WHERE id=$1 AND active=true",
                [c.owner_id],
              )
            ).length
              ? [c.owner_id]
              : []),
          ]),
        ];
        for (const uid of users) {
          const added = await tx.query(
            "INSERT INTO notifications(id,user_id,source_kind,source_id,fingerprint,title,body,href) VALUES ($1,$2,'contracts',$3,$4,$5,$6,$7) ON CONFLICT(user_id,fingerprint) DO NOTHING RETURNING id",
            [
              crypto.randomUUID(),
              uid,
              c.id,
              `contract:${c.id}:${c.end_date}:${bucket}`,
              c.name,
              days < 0
                ? `계약 기간이 ${Math.abs(days)}일 지났습니다.`
                : `종료일까지 ${days}일 남았습니다.`,
              `/contracts/${c.id}`,
            ],
          );
          notified += added.length;
        }
      }
      const inspections = await tx.query(
        "SELECT * FROM inspections WHERE deleted_at IS NULL AND status IN ('scheduled','in_progress') AND planned_date<=$1",
        [addDays(today, 7)],
      );
      for (const i of inspections) {
        const days = dayDiff(i.planned_date, today),
          bucket = days < 0 ? "overdue" : days === 0 ? "today" : "soon";
        const activeAssignee =
          i.assignee_id &&
          (
            await tx.query("SELECT id FROM users WHERE id=$1 AND active=true", [
              i.assignee_id,
            ])
          ).length;
        const users = activeAssignee
          ? [i.assignee_id]
          : managers.map((u) => u.id);
        for (const uid of users) {
          const added = await tx.query(
            "INSERT INTO notifications(id,user_id,source_kind,source_id,fingerprint,title,body,href) VALUES ($1,$2,'inspections',$3,$4,$5,$6,$7) ON CONFLICT(user_id,fingerprint) DO NOTHING RETURNING id",
            [
              crypto.randomUUID(),
              uid,
              i.id,
              `inspection:${i.id}:${i.planned_date}:${bucket}`,
              i.name,
              days < 0
                ? "점검 예정일이 지났습니다."
                : `점검 예정일: ${i.planned_date}`,
              `/inspections/${i.id}`,
            ],
          );
          notified += added.length;
        }
      }
      const breached = await tx.query(
        "SELECT * FROM tickets WHERE status NOT IN ('resolved','closed') AND ((first_response_at IS NULL AND response_due_at<now()) OR resolution_due_at<now())",
      );
      for (const ticket of breached) {
        for (const manager of managers) {
          const added = await tx.query(
            "INSERT INTO notifications(id,user_id,source_kind,source_id,fingerprint,title,body,href) VALUES ($1,$2,'tickets',$3,$4,$5,$6,$7) ON CONFLICT(user_id,fingerprint) DO NOTHING RETURNING id",
            [
              crypto.randomUUID(),
              manager.id,
              ticket.id,
              "sla:" +
                ticket.id +
                ":" +
                (ticket.first_response_at ? "resolution" : "response"),
              ticket.name,
              "응답 또는 해결 목표 시간이 지났습니다.",
              "/tickets/" + ticket.id,
            ],
          );
          notified += added.length;
        }
      }
      await tx.query(
        "DELETE FROM notifications n WHERE source_kind='tickets' AND EXISTS(SELECT 1 FROM tickets t WHERE t.id=n.source_id AND t.status IN ('resolved','closed'))",
      );
      await tx.query(
        "DELETE FROM notifications n WHERE n.source_kind='inspections' AND EXISTS(SELECT 1 FROM inspections i WHERE i.id=n.source_id AND (i.deleted_at IS NOT NULL OR i.status IN ('completed','cancelled')))",
      );
      await tx.query(
        "DELETE FROM notifications n WHERE n.source_kind='contracts' AND EXISTS(SELECT 1 FROM contracts c WHERE c.id=n.source_id AND (c.status='archived' OR c.renewal IN ('renewed','ended')))",
      );
      await tx.query(
        "DELETE FROM sessions WHERE expires_at<now() OR last_seen_at<now()-interval '8 hours'",
      );
      await tx.query("DELETE FROM download_grants WHERE expires_at<now()");
      await tx.query(
        "UPDATE import_batches SET payload='[]' WHERE committed_at IS NOT NULL AND payload<>'[]'::jsonb",
      );
      await tx.query(
        "DELETE FROM notifications WHERE read_at<now()-interval '90 days'",
      );
      await tx.query(
        "DELETE FROM login_attempts WHERE window_start<now()-interval '1 day'",
      );
      await tx.query(
        "DELETE FROM import_batches WHERE expires_at<now() AND committed_at IS NULL",
      );
      await tx.query(
        "UPDATE job_runs SET last_success=now(),last_error=NULL,updated_at=now() WHERE id='scheduler'",
      );
      return { created, notified };
    });
  } catch (e) {
    await db.query(
      "UPDATE job_runs SET last_error=$1,updated_at=now() WHERE id='scheduler'",
      ["scheduler_failed"],
    );
    throw e;
  }
}
