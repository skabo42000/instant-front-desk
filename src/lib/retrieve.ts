import "server-only";
import type { RetrievedChunk } from "./answer";
import type { businessRepository } from "./db/repository";
import { EMBEDDING_DIMENSIONS } from "./db/client";
import { FakeEmbeddings, type EmbeddingAdapter } from "./models/embeddings";
import { headingPatterns, isServiceOverview } from "./question-intents";

export type Repository = Pick<ReturnType<typeof businessRepository>, "getBusiness" | "listPageTexts" | "searchChunks" |
  "searchChunksByPattern" | "searchChunksByHeading" | "listHomepageSummary">;
export const RETRIEVAL_VERSION = "hybrid-v3";
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
  contactChunks: RetrievedChunk[];
}
// Question words -> Postgres regex (case-insensitive) for the section that usually holds that fact.
const FACTS: [RegExp, string][] = [
  [/\b(?:good|right|best) fit\b|\b(?:business types|industries)\b/i, "good fit|industries|businesses we (help|serve)|business with repetitive"],
  [/\b(?:located|regions?|service areas?)\b|where.{0,25}(?:based|serve|work)/i,
    "based in|suburbs|service areas?|serve.{0,25}(area|region|nation)|remotely across"],
  [/technical|tech.{0,12}skills|coding|programming/i, "no (technical|tech|coding)|technical skills|tech.skills|don't need.*(skills|technical)|do not need.*(skills|technical)"],
  [/delet|eras|remove.{0,20}(data|information)/i, "delet|eras|your choices"],
  [/sell|sold|selling/i, "sell|sold|selling|how we use"],
  [/pric(?:e|es|ing)|cost|charge|\bfees?\b/i, "pric(e|es|ing)|cost|budget|free strategy call"],
  [/launch|go live|goes live|how long|timing/i, "weeks|months|go live|goes live|launch"],
  [/phone|number|call|contact|reach/i, "\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}"],
  [/email/i, "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}"],
  [/address|located|location|where (?:is|are)|directions/i,
    "\\m\\d{2,6}\\s+[a-z0-9 .#-]{2,40}\\m(rt|route|st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|hwy|pkwy|suite|ste)\\M|\\m[a-z]{2}\\s+\\d{5}\\M"],
  [/hours|open|clos/i, "\\m\\d{1,2}(:\\d{2})?\\s*(am|pm|a\\.m\\.|p\\.m\\.)"],
  [/parking|\bpark\b/i, "parking"],
  [/book|appointment|schedul|reserv/i, "booking|appointment|schedul"],
  [/deal|discount|special|promo|coupon/i, "\\mdeals?\\M|discount|special|promo|\\d+\\s*%\\s*off"],
  [/\bwhen\b.*\b(?:updated|changed|revised|effective)\b|\blast (?:updated|changed)\b/i,
    "last updated|updated:|effective( date)?:|\\m(january|february|march|april|may|june|july|august|september|october|november|december)\\s+\\d{1,2},?\\s+\\d{4}"],
];
export function factPatterns(question: string): string[] {
  return FACTS.filter(([words]) => words.test(question)).map(([, pattern]) => pattern);
}
const PHRASE_STOP_WORDS = new Set(("a an the is are do does did what which when where who how much many can could i you your my " +
  "their they it its of for to and or in on at by with from please tell me about business we our us have has offer " +
  "use used using need there this that be will would should any some kind kinds type types").split(" "));
// Neighbouring question words ("good fit", "change ... software", "service providers") as Postgres
// regexes: up to two filler words between them, word stems so plurals still match.
export function phrasePatterns(question: string): string[] {
  const words = (question.toLowerCase().match(/[a-z]+/g) ?? []).filter(word => word.length > 2 && !PHRASE_STOP_WORDS.has(word))
    .map(word => word.length > 4 ? word.replace(/(?:es|s)$/, "") : word);
  const patterns: string[] = [];
  // Also pair words one apart, so "change my existing software" still finds "change my software".
  for (const gap of [1, 2]) for (let i = 0; i + gap < words.length; i++) {
    if (words[i] === words[i + gap]) continue;
    patterns.push(`\\m${words[i]}\\w*\\W+(\\w+\\W+){0,2}${words[i + gap]}`);
  }
  return [...new Set(patterns)].slice(0, 10);
}
// A phrase found in this many sections or more (for example the business name) points nowhere.
const COMMON_PHRASE_HITS = 4;
export async function retrieve(question: string, repo: Repository,
  options: { adapter?: EmbeddingAdapter; topK?: number; maxDistance?: number } = {},
): Promise<RetrievalResult> {
  const adapter = options.adapter ?? new FakeEmbeddings();
  await assertEmbeddingSpace(repo, adapter);
  const topK = options.topK ?? 8;
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new Error("topK must be 1 to 100");
  // Euclidean distance on normalized fake vectors; real models need calibration.
  const maxDistance = options.maxDistance ?? 1.25;
  if (!Number.isFinite(maxDistance) || maxDistance < 0) throw new Error("Invalid distance threshold");
  const contacts = extractContacts(await repo.listPageTexts());
  // Separate fallback evidence prevents contact sections from crowding out answer sections.
  const contactChunks = (await repo.searchChunksByPattern(
    "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}|\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}", adapter.model, 3,
  )).map(({ id, pageUrl, heading, text }) => ({ id, pageUrl, heading, text }));
  const embedding = await adapter.embed(question);
  if (embedding.length !== adapter.dimensions || !embedding.every(Number.isFinite)) throw new Error("Invalid embedding dimension/values");
  const hits = question.trim() && embedding.some(value => value !== 0)
    ? await repo.searchChunks(embedding, adapter.model, topK) : [];
  // Heading matches keep explicit lists and ordered steps together; keyword facts supplement vectors.
  const keywordHits = [];
  const headingHits = [];
  if (question.trim()) for (const pattern of headingPatterns(question)) headingHits.push(...await repo.searchChunksByHeading(pattern, adapter.model));
  // Some homepages put the service list under a marketing headline rather than "Services".
  if (isServiceOverview(question) && !headingHits.length) headingHits.push(...await repo.listHomepageSummary(adapter.model));
  if (question.trim()) for (const pattern of factPatterns(question)) keywordHits.push(...await repo.searchChunksByPattern(pattern, adapter.model, 2));
  const phraseHits = [];
  if (question.trim()) for (const pattern of phrasePatterns(question)) {
    const found = await repo.searchChunksByPattern(pattern, adapter.model, COMMON_PHRASE_HITS);
    if (found.length < COMMON_PHRASE_HITS) phraseHits.push(...found);
  }
  const seen = new Set<string>();
  const unique = <T extends { id: string }>(hit: T) => !seen.has(hit.id) && !!seen.add(hit.id);
  const chunks = [...headingHits.filter(unique).slice(0, 8), ...keywordHits.filter(unique).slice(0, 6),
    ...phraseHits.filter(unique).slice(0, 4), ...hits.filter(hit => hit.distance <= maxDistance).filter(unique)]
    .map(({ id, pageUrl, heading, text }) => ({ id, pageUrl, heading, text }));
  return { status: chunks.length ? "evidence" : "insufficient evidence", chunks, contacts, contactChunks };
}
