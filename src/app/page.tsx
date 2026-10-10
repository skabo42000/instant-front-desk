import { getLocalDatabase, listBusinesses } from "@/lib/local-businesses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Home() {
  const businesses = await listBusinesses(await getLocalDatabase());
  return <main className="mx-auto max-w-2xl space-y-6 px-6 py-12">
    <p className="text-sm">Local prototype</p>
    <h1 className="text-3xl font-bold">Instant Front Desk</h1>
    <p>Add a website to try an assistant for that business. Use only a website you have approval to read.</p>
    <ol className="list-inside list-decimal space-y-3">
      <li>Stop the local server by pressing Ctrl+C in its terminal.</li>
      <li>In the project terminal, run this command, replacing the example address with the approved website:
        <code className="my-2 block break-all rounded bg-slate-100 p-3">npm run ingest -- https://approved-site.example/</code></li>
      <li>Wait for it to finish, then run <code>npm run dev</code> and refresh this page.</li>
    </ol>
    <p>This preview uses practice answers, with no paid model calls. It may say the website doesn't contain an answer. Answer checks are coming later.</p>
    <h2 className="text-2xl font-semibold">Added businesses</h2>
    {businesses.length ? <ul className="space-y-2">{businesses.map(business => <li key={business.businessId}>
      <a className="underline" href={`/b/${encodeURIComponent(business.slug)}`}>{business.name}</a>
    </li>)}</ul> : <p>No businesses added yet. Follow the steps above to add one.</p>}
  </main>;
}
