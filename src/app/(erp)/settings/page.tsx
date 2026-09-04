import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Settings } from "@/components/settings";
export default async function Page() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/dashboard");
  return <Settings />;
}
