import { NextResponse } from "next/server";
import { assertOrigin, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/policy";
import { failure, parseInput, readJson } from "@/lib/http";
import { z } from "zod";
import { healthStatus } from "@/lib/operations";
import { listUsers, saveUser, setUserDeleted } from "@/lib/users";

const targetSchema = z
  .object({ id: z.string().uuid(), version: z.number().int().positive() })
  .strict();

export async function GET(request: Request) {
  try {
    const u = await requireUser();
    requirePermission(u.role, "users:write");
    const db = await getDb();
    const trash = new URL(request.url).searchParams.get("trash") === "1";
    const users = await listUsers(u, trash);
    const [assignmentUsers, jobs, history] = await Promise.all([
      trash ? listUsers(u) : Promise.resolve(users),
      db.query("SELECT * FROM job_runs"),
      db.query(
        "SELECT a.id,a.action,a.entity_kind,a.created_at,u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 50",
      ),
    ]);
    return NextResponse.json({
      users,
      assignment_users: assignmentUsers,
      jobs,
      history,
      health: await healthStatus(),
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "users:write");
    return NextResponse.json(await saveUser(u, await readJson(request)));
  } catch (e) {
    return failure(e);
  }
}

async function changeDeletion(request: Request, deleted: boolean) {
  try {
    assertOrigin(request);
    const user = await requireUser();
    requirePermission(user.role, "users:write");
    const input = parseInput(targetSchema, await readJson(request));
    return NextResponse.json(await setUserDeleted(user, { ...input, deleted }));
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  return changeDeletion(request, true);
}

export async function PATCH(request: Request) {
  return changeDeletion(request, false);
}
