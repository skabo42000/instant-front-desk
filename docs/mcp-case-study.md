# Case study: giving an AI assistant controlled access to saved reports

An AI assistant needs a controlled way to look up which businesses are saved and what went wrong in their recorded tests. This local prototype gives it three ways to read that information without giving it permission to change records. A fictional-data demonstration showed the assistant choosing all three tools and recovering from a rejected request. It does not establish real-business answer quality or customer use. Sources: [claims ledger](../../ai-os/context/claims.md), [saved fictional demo result](../data/mcp-fictional-demo/result.json).

**Status: local MCP prototype, built with AI coding agents.** Evidence dates: October 15–19, 2026. The fictional connected-assistant demonstration first passed on October 16, recorded in commit `984206e`, and was rerun on October 19. The files currently under `data/mcp-fictional-demo/` contain the October 19 rerun and replaced the October 16 files. The original pass remains documented in the historical walkthrough and claims ledger. Sources: [claims ledger](../../ai-os/context/claims.md), [October 16 walkthrough](../../ai-os/learning/mcp-walkthrough-2026-10-16.md), [October 19 run record](../../ai-os/projects/instant-front-desk.md), [current saved result](../data/mcp-fictional-demo/result.json).

## 1. Problem and scope

Instant Front Desk already saves business website records and evaluation reports. The integration problem was to let an assistant inspect approved records without arbitrary database access, write permissions or new model evaluations. The bounded questions are “Which approved businesses are saved?”, “How much content is saved?” and “What failed in the latest saved report?” Sources: [extension design](mcp.md), [read handler](../src/lib/mcp/api.ts).

This is an engineering demonstration rather than a customer engagement. The assistant-selected-tool example uses Maple Street Dental, an invented business with an invented report. Its website address is a label, never fetched. Sources: [fictional fixture](../tests/fixtures/mcp-maple-street-dental.json), [demo documentation](mcp.md#fictional-only-walkthrough-october-16-2026).

## 2. Acceptance criteria and observed evidence

| Criterion | Evidence and result |
| --- | --- |
| Expose exactly three read-only tools | Tool registration and saved assistant events show `list_businesses`, `get_business` and `get_evaluation_report`. Sources: [adapter](../src/lib/mcp/adapter.ts), [events](../data/mcp-fictional-demo/events.jsonl). |
| Restrict access to approved businesses and validate requests and replies | Both adapter and API enforce the business allowlist; strict schemas reject extra fields and invalid values. Offline coverage is recorded for scope, credentials and schemas. Sources: [adapter](../src/lib/mcp/adapter.ts), [API](../src/lib/mcp/api.ts), [contracts](../src/lib/mcp/contracts.ts), [tests](../tests/unit/mcp.test.ts), [October 15 verification](validation.md#offline-engineering-and-mcp-completion--october-15-2026). |
| Preserve honest report meaning | Missing reports return `null`; execution errors count among failures; reports identify their saved run and legacy single-verdict format. Sources: [read handler](../src/lib/mcp/api.ts), [contracts](../src/lib/mcp/contracts.ts). |
| Demonstrate an assistant choosing tools, separately from scripted checks | The October 19 rerun records all three successful tools after one schema rejection; the coordinator recorded `verified: true`. The October 16 first pass is retained as historical evidence in the walkthrough and ledger. Sources: [current result](../data/mcp-fictional-demo/result.json), [current events](../data/mcp-fictional-demo/events.jsonl), [October 19 run record](../../ai-os/projects/instant-front-desk.md), [October 16 walkthrough](../../ai-os/learning/mcp-walkthrough-2026-10-16.md), [ledger](../../ai-os/context/claims.md). |

These are bounded implementation and demonstration criteria, not release approval. The independent security and pilot gates remain open. Sources: [verification limits](mcp.md#verification-and-limits), [pilot gates](pilot.md).

## 3. Design decisions and why

The connection is:

```text
Assistant → MCP stdio adapter → authenticated loopback HTTP API → saved database
```

**Use the app's existing database connection.** Stdio means the assistant and adapter exchange messages through local process pipes. The adapter asks the running app for data at a fixed numeric loopback address; it never opens the database itself. That avoids a second process opening the app's PGlite database. Sources: [stdio entry point](../scripts/mcp.ts), [adapter](../src/lib/mcp/adapter.ts), [architecture](mcp.md#architecture-and-tools).

**Offer a small menu.** `list_businesses` returns approved business identifiers and metadata. `get_business` returns metadata and saved page/chunk counts. `get_evaluation_report` returns the latest saved legacy report, its provenance, counts and failure details. There is no tool for arbitrary SQL, URLs, files or writes. Sources: [contracts](../src/lib/mcp/contracts.ts), [read handler](../src/lib/mcp/api.ts).

**Check access on both sides.** The API is disabled by default and unavailable in pilot mode. It checks the secret, Host and browser-origin context. The adapter independently checks requested and returned business identifiers against its allowlist. The fictional runner generates a fresh random secret for each run, passes it privately through the process environment, and does not print or save it. Per-run generation belongs to this runner; ordinary app setup requires an operator-supplied secret. Sources: [API](../src/lib/mcp/api.ts), [adapter](../src/lib/mcp/adapter.ts), [fictional runner](../scripts/demo-mcp-fictional.mjs), [setup](mcp.md#setup).

**Bound the data and waiting time.** Strict input/output schemas reject unexpected properties and cap pages at 10 entries. The adapter rejects redirects, caps response bytes and imposes a timeout. Pagination and truncation are explicit; later failure pages require a report identifier to avoid mixing runs. Retrieved website text is labeled untrusted data. Sources: [contracts](../src/lib/mcp/contracts.ts), [adapter](../src/lib/mcp/adapter.ts), [API](../src/lib/mcp/api.ts).

## 4. Recorded verification

The following are historical executed checks, not tests rerun while writing this case study.

| Date | Actual recorded command | Recorded result and source |
| --- | --- | --- |
| October 15, 2026 | `npm test` | 319 offline tests passed across 25 files, including MCP contracts/security/SDK integration. This is the full project suite, not 319 MCP-specific tests. [Validation record](validation.md#offline-engineering-and-mcp-completion--october-15-2026). |
| October 15, 2026 | `node scripts/check-mcp.cjs` | Scripted official-SDK stdio discovery and reads against two owned-site records passed. This did not involve an assistant selecting tools or new answer evaluations. [Validation record](validation.md#offline-engineering-and-mcp-completion--october-15-2026). |
| October 16, 2026 | `node scripts/demo-mcp-fictional.mjs --smoke` | Scripted connection passed over fictional data, with no application model calls. [Recorded walkthrough](../../ai-os/learning/mcp-walkthrough-2026-10-16.md), [runner assertions](../scripts/demo-mcp-fictional.mjs). |
| October 16, 2026 | `node scripts/demo-mcp-fictional.mjs --assistant` | Historical first pass: Codex selected all three tools and recovered from a rejected `limit: 100` request. Its original result/events files were replaced by the October 19 rerun. [Historical walkthrough](../../ai-os/learning/mcp-walkthrough-2026-10-16.md), [claims ledger](../../ai-os/context/claims.md), commit `984206e`. |
| October 16, 2026 | `node scripts/demo-mcp-fictional.mjs --verify` | Recorded `verified: true`; the verifier checks tool selection, fictional identifiers, report details and evidence limits. [Recorded walkthrough](../../ai-os/learning/mcp-walkthrough-2026-10-16.md), [verifier](../scripts/demo-mcp-fictional.mjs); claim approved in [ledger](../../ai-os/context/claims.md). |
| October 19, 2026 | `node scripts/demo-mcp-fictional.mjs --smoke` | Coordinator recorded three tools and fictional report counts of 3 total, 1 passed, 2 failed and 1 error, with zero application model calls. [October 19 run record](../../ai-os/projects/instant-front-desk.md). |
| October 19, 2026 | `node scripts/demo-mcp-fictional.mjs --assistant` | Codex's `list_businesses(limit: 100)` request was rejected; it retried with 10, then called `get_evaluation_report` and `get_business`. The saved result records success, zero application model calls, subscription inference and stopped processes. [Current result](../data/mcp-fictional-demo/result.json), [current events](../data/mcp-fictional-demo/events.jsonl). |
| October 19, 2026 | `node scripts/demo-mcp-fictional.mjs --verify` | Coordinator recorded `verified: true`. [October 19 run record](../../ai-os/projects/instant-front-desk.md), [verifier](../scripts/demo-mcp-fictional.mjs). |

The October 19 demonstration reads the same invented report: three questions, one pass and two failures, including one judge execution error. Its October 16 report and crawl timestamps belong to the fixture; they do not date the October 19 execution. The assistant explained the omitted Saturday hours and distinguished a grading error from proof of an incorrect answer. The runner recorded process cleanup. The assistant step used subscription inference; it was not offline, even though the app made no Gemini/Groq calls. Sources: [fixture](../tests/fixtures/mcp-maple-street-dental.json), [saved result](../data/mcp-fictional-demo/result.json), [runner](../scripts/demo-mcp-fictional.mjs).

The verifier was corrected to accept a rejected call that returned no data when followed by successful tool use, while retaining the rejection in its evidence. This makes recovery visible instead of treating it as an entirely successful sequence. Source: [verification logic and comment](../scripts/demo-mcp-fictional.mjs), [saved rejected-call count](../data/mcp-fictional-demo/result.json).

## 5. What this does not prove

- No assistant-selected-tool run over real business data is established. The owned-site evidence is scripted; the assistant demonstration is fictional only. [Claims ledger](../../ai-os/context/claims.md).
- No deployment or customer use is established. This remains a local prototype. [Claims ledger](../../ai-os/context/claims.md), [project README](../README.md).
- These demo records do not establish a completed independent MCP security review. The October 17 independent AI review covered the budget/stop design with conditions; it does not certify MCP or pilot release. [Claims ledger](../../ai-os/context/claims.md), [extension limits](mcp.md#verification-and-limits), [pilot gates](pilot.md).
- Saved legacy report scores are not current service health or human-calibrated accuracy. File-only newer diagnostics are not substituted for database reports. [Report scope](mcp.md#architecture-and-tools), [read handler](../src/lib/mcp/api.ts).

## 6. Next steps

These are proposed steps, not completed work or authorization to release:

1. If a real-data assistant demonstration is needed, obtain specific approval for the payload and receiving service first; keep its evidence separate from this fictional demonstration. [Data boundary and demo scope](mcp.md), [claims ledger](../../ai-os/context/claims.md).
2. Verify the new Mac Postgres adapter and lifecycle and resolve MCP security and remaining pilot gates before considering a release. The October 17 local direct-SQL proof has a narrower scope. [Claims ledger](../../ai-os/context/claims.md), [extension limits](mcp.md#verification-and-limits), [pilot plan](pilot.md).
3. Beginner exercise: without notes, explain which tool supplies failure reasons and why `limit: 100` was rejected, then compare the answer with the [saved tool calls](../data/mcp-fictional-demo/result.json) and [input schema](../src/lib/mcp/contracts.ts). This document does not establish that Bosko has mastered the implementation.

Evidence under `data/` is private local material and may be absent from a public checkout. The versioned fixture, verifier, documentation and approved ledger preserve the scope of the claim; the fixture alone is not proof that an assistant ran. Source: [demo evidence storage and verification](../scripts/demo-mcp-fictional.mjs), [demo documentation](mcp.md).
