import { ScaffoldStatus } from "@/components/ScaffoldStatus";
import { getClientConfig, getServerConfig } from "@/lib/config";

// Read server settings at request time, never cache credentials into a static page.
export const dynamic = "force-dynamic";

export default function Home() {
  const config = getServerConfig();
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-20 text-slate-900">
      <section className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-8">
        <p className="mb-3 text-sm font-semibold text-slate-600">Local prototype</p>
        <h1 className="mb-4 text-3xl font-bold">Instant Front Desk</h1>
        <p className="mb-6">Scaffold only. Website import, chat and score cards are planned.</p>
        <ScaffoldStatus config={getClientConfig(config)} />
      </section>
    </main>
  );
}
