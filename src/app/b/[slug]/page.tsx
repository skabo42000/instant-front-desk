import { notFound } from "next/navigation";
import { Chat } from "@/components/Chat";
import { ScoreCard } from "@/components/ScoreCard";
import { findBusiness, getLocalDatabase } from "@/lib/local-businesses";
import { latestReport } from "@/lib/eval/runner";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function BusinessPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const business = await findBusiness(await getLocalDatabase(), slug);
  if (!business) notFound();
  return <main className="mx-auto max-w-2xl space-y-8 px-6 py-12">
    <header><p className="mb-2 text-sm">Local prototype</p><h1 className="text-3xl font-bold">{business.name}</h1></header>
    <Chat slug={business.slug} />
    <ScoreCard report={await latestReport(await getLocalDatabase(), business.businessId)} />
  </main>;
}
