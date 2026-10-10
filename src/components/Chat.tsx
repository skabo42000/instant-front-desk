"use client";
import { useState, type FormEvent } from "react";
import type { Citation } from "@/lib/answer";
export interface ChatReply { kind: "answer" | "refusal"; text: string; citations: Citation[] }
export function ChatAnswer({ reply }: { reply: ChatReply }) {
  return <div className="rounded-lg border p-4">
    <p className="mb-2 font-semibold">{reply.kind === "refusal" ? "The website doesn't say" : "Answer"}</p>
    <p className="whitespace-pre-wrap">{reply.text}</p>
    {reply.citations.length > 0 && <ul className="mt-3 list-inside list-disc">{reply.citations.map(citation =>
      <li key={citation.id}><a className="underline" href={citation.pageUrl} target="_blank" rel="noreferrer">{citation.heading || "Website source"}</a></li>)}</ul>}
  </div>;
}
export function Chat({ slug }: { slug: string }) {
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState<ChatReply | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !question.trim()) return;
    setBusy(true); setError(""); setReply(null);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, question }) });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "Please try again later.");
      else setReply(body);
    } catch { setError("Unable to reach the assistant. Please try again."); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="chat-title" className="space-y-4">
    <h2 id="chat-title" className="text-2xl font-semibold">Ask about this business</h2>
    <p>Answers use information from the website. This local preview may be unable to answer. Questions and answers are not saved.</p>
    <form onSubmit={submit} className="space-y-3">
      <label htmlFor="question" className="block font-medium">Your question</label>
      <textarea id="question" value={question} onChange={event => setQuestion(event.target.value)} maxLength={2000}
        required rows={3} className="w-full rounded-lg border p-3" />
      <button disabled={busy || !question.trim()} className="rounded-lg bg-slate-900 px-5 py-2 text-white disabled:opacity-50">{busy ? "Looking for an answer…" : "Ask"}</button>
    </form>
    <div aria-live="polite">{error && <p role="alert">{error}</p>}{reply && <ChatAnswer reply={reply} />}</div>
  </section>;
}
