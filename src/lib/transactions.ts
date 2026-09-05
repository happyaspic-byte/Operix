import type { Database } from "./db";
// All relation mutations use one lock order; reads remain concurrent through MVCC.
export async function lockBusiness(db: Database) {
  await db.query(
    "SELECT id FROM operation_locks WHERE id='business' FOR UPDATE",
  );
}
