import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function ErpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <Shell user={user}>{children}</Shell>;
}
