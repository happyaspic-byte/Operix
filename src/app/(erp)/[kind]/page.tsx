import { notFound } from "next/navigation";
import { catalog } from "@/lib/catalog";
import { EntityList } from "@/components/entity-list";
export default async function Page({
  params,
}: {
  params: Promise<{ kind: string }>;
}) {
  const { kind } = await params;
  if (!catalog[kind]) notFound();
  return <EntityList entity={kind} />;
}
