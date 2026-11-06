import { VisitPrep } from "@/components/visit-prep";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <VisitPrep id={(await params).id} />;
}
