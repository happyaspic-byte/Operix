import { AppError } from "./policy";

// Call after loading the record inside the business-lock transaction.
// Historical reads remain available after erasure or soft deletion.
export function assertRecordWritable(record: Record<string, unknown>) {
  if (record.privacy_erased_at)
    throw new AppError(410, "파기된 자료는 다시 수정할 수 없습니다.");
  if (record.deleted_at)
    throw new AppError(410, "삭제된 자료는 복원 후 수정해 주세요.");
}
