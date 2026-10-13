import "server-only";
import type { RetrievedChunk } from "./answer";
import type { businessRepository } from "./db/repository";
import { EMBEDDING_DIMENSIONS } from "./db/client";
import { FakeEmbeddings, type EmbeddingAdapter } from "./models/embeddings";

export type Repository = ReturnType<typeof businessRepository>;
export interface GroundedContact { kind: "phone" | "email"; value: string; pageUrl: string }
export function extractContacts(pages: readonly { pageUrl: string; text: string }[]): GroundedContact[] {
  const contacts: GroundedContact[] = [];
  for (const page of pages) {
    const matches = page.text.match(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/gi) ?? [];
    for (const value of matches) {
      if (!contacts.some(contact => contact.value === value)) {
        contacts.push({ kind: value.includes("@") ? "email" : "phone", value, pageUrl: page.pageUrl });
      }
    }
  }
  return contacts;
}

export async function assertEmbeddingSpace(repo: Repository, adapter: EmbeddingAdapter): Promise<void> {
  const business = await repo.getBusiness();
  if (!business || business.embeddingModel !== adapter.model || adapter.dimensions !== EMBEDDING_DIMENSIONS ||
      business.embeddingDimensions !== adapter.dimensions) throw new Error("Embedding model/dimension mismatch or business missing");
}
export interface RetrievalResult {
  status: "evidence" | "insufficient evidence";
  chunks: RetrievedChunk[];
  contacts: GroundedContact[];
}
// Question words -> Postgres regex (case-insensitive) for the section that usually holds that fact.
const FACTS: [RegExp, string][] = [
  [/phone|number|call|contact|reach/i, "\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}"],
  [/email/i, "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}"],
  [/address|located|location|where (?:is|are)|directions/i,
    "\\m\\d{2,6}\\s+[a-z0-9 .#-]{2,40}\\m(rt|route|st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|hwy|pkwy|suite|ste)\\M|\\m[a-z]{2}\\s+\\d{5}\\M"],
  [/hours|open|clos/i, "\\m\\d{1,2}(:\\d{2})?\\s*(am|pm|a\\.m\\.|p\\.m\\.)"],
  [/parking|\bpark\b/i, "parking"],
  [/book|appointment|schedul|reserv/i, "booking|appointment|schedul"],
];
export function factPatterns(question: string): string[] {
  return FACTS.filter(([words]) => words.test(question)).map(([, pattern]) => pattern);
}
export async function retrieve(question: string, repo: Repository,
  options: { adapter?: EmbeddingAdapter; topK?: number; maxDistance?: number } = {},
): Promise<RetrievalResult> {
  const adapter = options.adapter ?? new FakeEmbeddings();
  await assertEmbeddingSpace(repo, adapter);
  const topK = options.topK ?? 5;
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new Error("topK must be 1 to 100");
  // Euclidean distance on normalized fake vectors; real models need calibration.
  const maxDistance = options.maxDistance ?? 1.25;
  if (!Number.isFinite(maxDistance) || maxDistance < 0) throw new Error("Invalid distance threshold");
  const contacts = extractContacts(await repo.listPageTexts());
  const embedding = await adapter.embed(question);
  if (embedding.length !== adapter.dimensions || !embedding.every(Number.isFinite)) throw new Error("Invalid embedding dimension/values");
  const hits = question.trim() && embedding.some(value => value !== 0)
    ? await repo.searchChunks(embedding, adapter.model, topK) : [];
  // Hybrid search: contact-type questions (phone, address, hours, parking, booking) also get up to
  // three sections found by keyword, because meaning-based search often ranks those sections low.
  const keywordHits = [];
  if (question.trim()) for (const pattern of factPatterns(question)) keywordHits.push(...await repo.searchChunksByPattern(pattern, adapter.model, 2));
  const seen = new Set<string>();
  const unique = <T extends { id: string }>(hit: T) => !seen.has(hit.id) && !!seen.add(hit.id);
  const chunks = [...hits.filter(hit => hit.distance <= maxDistance).filter(unique), ...keywordHits.filter(unique).slice(0, 3)]
    .map(({ id, pageUrl, heading, text }) => ({ id, pageUrl, heading, text }));
  return { status: chunks.length ? "evidence" : "insufficient evidence", chunks, contacts };
}
