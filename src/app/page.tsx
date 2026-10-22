import { getBusinessData } from "@/lib/business-data";
import { headers } from "next/headers";
import { AddWebsite } from "@/components/AddWebsite";
import { localIngestAllowed } from "@/lib/local-ingest-policy";
import { DEFAULT_CRAWL_LIMITS } from "@/lib/crawl/crawl";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Home() {
  const businesses = await getBusinessData().list();
  const pilot = process.env.IFD_PILOT_MODE === "yes";
  const canAddWebsite = localIngestAllowed(await headers());
  return <main className="mx-auto max-w-2xl space-y-6 px-6 py-12">
    <p className="text-sm">{pilot ? "Invitation-only prototype" : "Local prototype"}</p>
    <h1 className="text-3xl font-bold">Instant Front Desk</h1>
    {canAddWebsite && <AddWebsite maxPages={DEFAULT_CRAWL_LIMITS.maxPages} />}
    {pilot && <p>Choose a business below and ask about information on its website. Check the linked sources before relying on an answer. Please avoid sharing personal or sensitive information.</p>}
    <p>Each business page shows whether chat is in practice mode or uses live website answers. Saved answer checks appear alongside the chat.</p>
    <h2 className="text-2xl font-semibold">Added businesses</h2>
    {businesses.length ? <ul className="space-y-2">{businesses.map(business => <li key={business.businessId}>
      <a className="underline" href={`/b/${encodeURIComponent(business.slug)}`}>{business.name}</a>
    </li>)}</ul> : <p>No businesses added yet.</p>}
  </main>;
}
