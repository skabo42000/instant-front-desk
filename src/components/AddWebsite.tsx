"use client";
import { useRef, useState, type FormEvent } from "react";

export function AddWebsite({ maxPages }: { maxPages: number }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const url = new FormData(event.currentTarget).get("url");
    busy.current = true; setLoading(true); setError("");
    try {
      const response = await fetch("/api/ingest", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }) });
      const result = await response.json();
      if (!response.ok) { setError(result.error || "Could not load the website."); return; }
      window.location.assign(result.location);
    } catch { setError("Could not connect. If a load is still running, wait a few minutes before trying again."); }
    finally { busy.current = false; setLoading(false); }
  }
  return <form onSubmit={submit} aria-busy={loading} className="space-y-3 rounded-lg border p-5">
    <label htmlFor="website-url" className="block text-2xl font-semibold">Add a website</label>
    <p id="website-help">Loads up to {maxPages} public pages from this one site, respects robots.txt, and takes about a minute. Larger sites can take longer. Use a website you have approval to read.</p>
    <input id="website-url" name="url" type="url" required maxLength={2048} placeholder="https://example.com"
      aria-describedby="website-help" disabled={loading} className="w-full rounded border p-3" />
    <button type="submit" disabled={loading} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60">{loading ? "Loading website…" : "Load website"}</button>
    <p role="status" aria-live="polite">{loading ? "Reading public pages and preparing your assistant. Please keep this page open." : ""}</p>
    {error && <p role="alert">{error}</p>}
  </form>;
}
