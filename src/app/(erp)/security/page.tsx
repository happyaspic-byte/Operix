import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/policy";
import { SecurityReview } from "@/components/security-review";
export default async function SecurityPage() {
  const u = await requireUser();
  if (!can(u.role, "audit")) notFound();
  return <SecurityReview />;
}
