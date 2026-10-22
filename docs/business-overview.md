# Business overview retrieval — October 22, 2026

The generic BUSINESS_OVERVIEW intent recognizes English summary/overview requests
and short questions such as “What do you do?” and “Tell me about your company”.
Serbian/Croatian Latin examples include “O čemu se radi?”, “Šta radite?”, “Što
radite?”, “Ko ste?” and “Tko ste?”, with or without accents.

Overview retrieval uses existing business/model-scoped heading reads. It takes
the homepage's leading chunks in page order, including short introductions,
then supplements them with about, service/product and contact/location sections
from other pages. It deduplicates IDs and keeps at most eight evidence chunks,
within the existing heading-evidence allowance. Each database read retains the
existing 20-row limit. No new database function, schema, model or provider call
is needed for this evidence selection.

Privacy, terms, cookie, policy and legal pages/headings are excluded from overview
evidence and contact fallback unless the question explicitly asks about those
topics. Direct privacy-policy and price questions retain the previous retrieval
and answer path. Overview answers receive an additional instruction to briefly
describe the business, its services/products, stated location/area and stated
contact/booking details. Existing grounding checks, citations, untrusted-source
handling and empty-evidence refusals still apply. Missing details are omitted.

## Frozen-question scope check

`node scripts/check-overview-intent.cjs` reads JSON under `benchmarks/` and
`data/benchmarks/`, identifies saved case sets structurally, and reports every
matching question. It uses no credentials, database, network or model calls and
does not edit benchmark inputs or results.

The October 22 offline check inspected 50 JSON files and found 10 saved question
sets, each with 26 entries (260 entries across copies/plans). **Matching questions:
none (`[]`).** This checks intent overlap, not live answer quality or a new gate
score. The retained audit is `data/business-overview-intent-audit-2026-10-22.json`.

| Saved set | Entries | Matches |
| --- | ---: | ---: |
| `benchmarks/owned-sites/2026-10-15/salon/draft.json` | 26 | 0 |
| `benchmarks/owned-sites/2026-10-15/synq/draft.json` | 26 | 0 |
| `data/benchmarks/2026-10-15/salon/ai-reviewed.json` | 26 | 0 |
| `data/benchmarks/2026-10-15/salon/draft.json` | 26 | 0 |
| `data/benchmarks/2026-10-15/synq/ai-reviewed.json` | 26 | 0 |
| `data/benchmarks/2026-10-15/synq/draft.json` | 26 | 0 |
| `data/benchmarks/2026-10-17/salon-answer-plan.json` | 26 | 0 |
| `data/benchmarks/2026-10-17/synq-answer-plan.json` | 26 | 0 |
| `data/benchmarks/salon-accepted.json` | 26 | 0 |
| `data/benchmarks/synq-accepted.json` | 26 | 0 |

Verification uses fictional pages and scripted replies; no new live-site or
live-model quality evidence is claimed. The bounded candidate reads can omit
later sections on unusually long pages. The assistant must omit any detail not
present in its selected evidence.

Beginner exercise: predict which homepage and service chunks an overview keeps
when a privacy page has the closest word match, then compare the overview test.
This suggestion is not evidence of an attempt or mastery.
