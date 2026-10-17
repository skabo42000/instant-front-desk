# AI source review — October 15, 2026

Bosko declined the manual labeling task and delegated review to Codex. All **52
questions** were checked against the saved owned-site sources: 40 source questions
and 12 traps. All were retained; none were silently excluded. The original
question strings, snapshots and query embeddings remain unchanged.

**Reviewer: Codex (AI assistant). Human review: not performed.** No human name,
signature or calibration result was invented. The review used this assistant's
source reading and offline checks, with no new model API calls, crawl or spending.
It is not an independent human assessment or a verification of live business claims.

## Artifacts

- Each site's `benchmarks/owned-sites/2026-10-15/*/ai-review-notes.json` contains
  an explicit decision, revised expected behavior, required facts, exact supporting
  quotations and notes for every case.
- [Review summary](../benchmarks/results/2026-10-15-ai-review-summary.json) lists
  all cases and their provenance. The private read-only browser report is
  `data/benchmarks/2026-10-15/ai-review-summary.html`; it requests no manual work.
- [Retrieval results](../benchmarks/results/2026-10-15-retrieval-ai-reviewed.json)
  record the new benchmark hashes and per-case rankings.
- Rebuilt bundles are private local artifacts under
  `data/benchmarks/2026-10-15/{synq,salon}/ai-reviewed.json`. Reproduce them from
  the versioned drafts/notes with `npm run benchmark -- apply-ai-review DRAFT NOTES OUTPUT`.

The importer verifies every quote against the frozen same-business source,
rejects omitted/duplicate cases or unsupported quotations, and always marks this
workflow `method: "ai"`. Quote matching checks provenance; the meaning of a fact
was reviewed by the AI, not proven by a string-matching script. The notes have
their own hash in the reviewed bundle.

## Corrections

- Cookie question: require the no-cookie answer for visit analytics. The extra
  personal-identification detail is optional because the question did not ask it.
  Do not generalize that to every website storage mechanism or external booking site.
- Location and technical-skill questions: accept equivalent wording; do not demand
  a state abbreviation or an email analogy for an otherwise adequate answer.
- Retrieval: group evidence by required fact. Any annotated supporting alternative
  is sufficient, so repeated footers and FAQ copies do not all need retrieval.
- Process question: require the four substantive stages, not the introductory
  process-heading chunk as a fifth mandatory source.
- Privacy: distinguish "does not ask for name/email/phone" from a false claim that
  visitors cannot type personal information into messages.
- Conditional claims: preserve booking activation, "usually" compatible software,
  and powder-brow duration "up to three years with proper care".
- Time-sensitive deals, delivery timelines and recognition claims are source-stated
  assertions, not verified current offers, guaranteed outcomes or independently
  validated awards. These cautions remain in the per-case notes.
- Traps: do not require citations proving absence or contact offers not requested
  by the case. The unlisted-price trap still explicitly requires a grounded contact
  fallback. The private-home-address trap must never return the business address.

## Offline retrieval on the new labels

| Saved site | Source questions | Hybrid complete at 8 | BM25 complete at 8 |
| --- | --- | --- | --- |
| Synq Logic | 20 | 20/20 | 18/20 |
| European Beauty Lounge | 20 | 20/20 | 20/20 |

All annotated facts also survived answer filtering in these offline runs. The
six traps per site have no factual reference and are excluded from recall.
Hybrid remains the default: the reranker loses coverage on Synq and adds no salon
coverage. This is a small AI-labeled test set, not general retrieval performance.

These are **new-label baselines**, not improvements in the model. The earlier
draft used different expectations and duplicate-ID requirements; benchmark hashes
differ and the answer comparison tool rejects that mismatch. No new answers or
live judge grades were generated. Existing free-tier exhaustion and inconclusive
live diagnostics are unchanged.

Reports carry `reviewMethod: "ai"`, `humanReviewed: false` and `provisional: true`.
The human workflow remains separately available and records explicit human
provenance only after its personal-review attestation. AI-only artifacts cannot
satisfy the existing human-calibrated release policy: SQL imports remain guarded
and readiness checks the bundle's actual review method, not just a report flag.
Any future change to a controlled prototype's release policy must be explicit in
its reviewable approval packet; no such deployment/sign-off is claimed here.
