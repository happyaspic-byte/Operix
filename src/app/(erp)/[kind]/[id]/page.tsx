import { notFound } from "next/navigation";
import { catalog } from "@/lib/catalog";
import { EntityDetail } from "@/components/entity-detail";
export default async function Page({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const p = await params;
  if (!catalog[p.kind]) notFound();
  return <EntityDetail kind={p.kind} id={p.id} />;
}
