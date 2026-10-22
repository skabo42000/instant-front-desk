import { notFound } from "next/navigation";
import { Chat } from "@/components/Chat";
import { ScoreCard } from "@/components/ScoreCard";
import { getBusinessData } from "@/lib/business-data";
import { websiteLoadSummary } from "@/lib/website-load-summary";
import { WebsiteLoadNote } from "@/components/WebsiteLoadNote";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function BusinessPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = getBusinessData();
  const business = await data.find(slug);
  if (!business) notFound();
  const practice = business.embeddingModel === "fake-token-hash-v1";
  const live = process.env.LOCAL_CHAT_MODE === "real" && process.env.FREE_TIER_CONFIRMED === "yes";
  const pilot = process.env.IFD_PILOT_MODE === "yes";
  const loaded = !pilot ? websiteLoadSummary(slug) : undefined;
  return <main className="mx-auto max-w-2xl space-y-8 px-6 py-12">
    <header><p className="mb-2 text-sm">{pilot ? "Invitation-only prototype" : "Local prototype"}</p><h1 className="text-3xl font-bold">{business.name}</h1></header>
    {loaded && <WebsiteLoadNote summary={loaded} host={new URL(business.sourceUrl).hostname} />}
    <p>{practice ? "Practice mode: replies are simulated and may be unavailable." : live
      ? pilot ? "Ask about the website below. Check the linked sources and avoid sharing personal information." : "Live website answers are enabled for this local preview." : "Live chat is currently off. Saved answer checks are available below."}</p>
    <Chat slug={business.slug} />
    <ScoreCard report={await data.report(business.businessId)} />
  </main>;
}
