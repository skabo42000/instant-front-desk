import "server-only";
import { fingerprint, importReview, type Benchmark } from "./benchmark";

export interface AiReviewNotes {
  schema: 1;
  method: "ai";
  reviewer: string;
  reviewedAt: string;
  draftHash: string;
  scope: string;
  cases: {
    id: string;
    expectedBehavior: string;
    facts: { fact: string; quotes: string[] }[];
    decision: "include" | "exclude";
    exclusionReason: string;
    notes: string;
  }[];
}
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g," ").trim().toLowerCase();

// The assistant writes the semantic labels after reading the snapshot. This helper
// checks the quoted evidence and provenance; string matching is not a semantic judge.
export function applyAiReview(draft: Benchmark, notes: AiReviewNotes): Benchmark {
  if (notes.schema !== 1 || notes.method !== "ai" || !notes.reviewer.trim() || !notes.scope.trim() ||
    notes.draftHash !== draft.draftHash || notes.cases.length !== draft.cases.length ||
    new Set(notes.cases.map(q => q.id)).size !== notes.cases.length) throw new Error("AI review notes do not match draft");
  const reviewed = structuredClone(draft);
  reviewed.cases = draft.cases.map(q => {
    const note = notes.cases.find(n => n.id === q.id);
    if (!note || !note.notes.trim()) throw new Error("Every case requires explicit review notes");
    if (q.kind !== "source" && note.facts.length) throw new Error("Trap behavior is not sourced factual evidence");
    const evidenceGroups = note.facts.map(f => {
      if (!f.fact.trim() || !f.quotes.length || f.quotes.length > 10) throw new Error("Fact needs quoted support");
      const ids = new Set<string>();
      for (const quote of f.quotes) {
        if (quote.trim().length < 8 || quote.length > 1000) throw new Error("Evidence quote must be specific and bounded");
        const found = draft.snapshot.chunks.filter(c => normalize(`${c.heading} ${c.text}`).includes(normalize(quote)));
        if (!found.length) throw new Error(`No saved source matches reviewed quote for case ${q.id}`);
        found.forEach(c => ids.add(c.id));
      }
      return [...ids].sort();
    });
    return { ...q, expectedBehavior: note.expectedBehavior, requiredFacts: note.facts.map(f => f.fact), evidenceGroups,
      evidenceChunkIds: [...new Set(evidenceGroups.flat())].sort(), reviewNotes: note.notes,
      decision: note.decision, exclusionReason: note.exclusionReason };
  });
  reviewed.review = { method: "ai", reviewer: notes.reviewer, reviewedAt: notes.reviewedAt,
    attestation: true, draftHash: notes.draftHash, notesHash: fingerprint(notes) };
  return importReview(draft, reviewed);
}
