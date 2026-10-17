import { z } from "zod";
export const MAX_RESPONSE_BYTES = 128 * 1024;
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const text = z.string().max(2000);
const label = z.string().max(200);
const publicUrl = z.string().max(2048).url().refine(value => {
  const u = new URL(value); return ["https:","http:"].includes(u.protocol) && !u.username && !u.password;
});
const cursor = z.number().int().min(0).max(10000);
const page = { limit: z.number().int().min(1).max(10).optional(), cursor: cursor.optional() };
export const listInput = z.strictObject(page);
export const businessInput = z.strictObject({ businessId: uuid });
export const reportInput = z.strictObject({ businessId: uuid, ...page, reportId: uuid.optional() })
  .refine(v => !v.cursor || !!v.reportId, "Subsequent pages require the saved report ID");
export const businessSchema = z.strictObject({ businessId: uuid, name: label, slug: label, sourceUrl: publicUrl });
const nullableLabel = label.nullable();
export const listOutput = z.strictObject({ businesses: z.array(businessSchema).max(10), nextCursor: cursor.nullable(), truncated: z.boolean() });
export const businessOutput = z.strictObject({ business: businessSchema.extend({ pageCount: z.number().int().nonnegative(), chunkCount: z.number().int().nonnegative(), latestCrawlAt: z.string().max(40).nullable() }), truncated: z.boolean() });
const failureSchema = z.strictObject({ questionId: uuid, question: text, answer: text.nullable(), reason: text.nullable(), error: nullableLabel });
export const reportOutput = z.strictObject({ businessId: uuid, report: z.strictObject({
  id: uuid, at: z.string().max(40), questionVersion: z.number().int().positive(), snapshotId: uuid,
  answerModel: nullableLabel, judgeModel: nullableLabel, answerPromptVersion: nullableLabel, judgePromptVersion: nullableLabel,
  reportKind: z.literal("legacy-single-verdict"), total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), errors: z.number().int().nonnegative(),
  failures: z.array(failureSchema).max(10), nextCursor: cursor.nullable(),
}).nullable(), truncated: z.boolean(), evidenceScope: z.literal("Saved evaluation only; not current service health or calibrated accuracy.") });
export const contracts = {
  list_businesses: { input: listInput, output: listOutput },
  get_business: { input: businessInput, output: businessOutput },
  get_evaluation_report: { input: reportInput, output: reportOutput },
} as const;
export type ToolName = keyof typeof contracts;
export function toolName(value: string): value is ToolName { return Object.hasOwn(contracts, value); }
export function mcpSettings(env: Readonly<Record<string,string|undefined>>) {
  const origin = new URL(env.IFD_MCP_ORIGIN || "http://127.0.0.1:3000");
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw Error("Invalid local MCP origin");
  const token = env.IFD_MCP_TOKEN || "";
  const allowed = (env.IFD_MCP_BUSINESS_IDS || "").split(",").map(v=>v.trim()).filter(Boolean);
  if (token.length < 32 || token.length > 256 || !/^[\x21-\x7e]+$/.test(token) || !allowed.length || allowed.length > 20 || allowed.some(id=>!uuid.safeParse(id).success)) throw Error("MCP requires a local secret and business allowlist");
  return { origin: origin.origin, token, allowed: [...new Set(allowed)].sort() };
}
