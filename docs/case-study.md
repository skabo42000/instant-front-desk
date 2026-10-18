# Case study: a website assistant that is tested before anyone talks to it

**Status: local prototype on two owned websites, built with AI coding agents (Claude Code, Codex).** No customer
use, deployment or human-validated accuracy is claimed. Evidence dates: October 14–17, 2026. Draft for review
against the claims ledger before external use.

## The problem

Small businesses want a chat assistant on their website, but a wrong answer about a price, opening hours or a
treatment hurts them more than no answer. The goal was to paste a business's website and get two things: an
assistant that answers only from that site, and a score card showing how well it answers *before* it goes live.

## What I built

- **Ingestion:** crawls a site within robots.txt and size limits, blocks private addresses, treats all page text as
  untrusted data, stores pages and chunks in Postgres with pgvector.
- **Answering:** hybrid retrieval over the saved chunks, a grounded answer prompt that must cite chunk IDs, and
  deterministic checks: injection phrases refused, unknown citations rejected, unsupported numbers blocked.
  Refusals give the business's real contact details from its own site.
- **Evaluation:** a fixed benchmark per site of 20 questions written from the site's own text plus 6 trap
  questions (information not listed, competitor questions, prices not listed, "ignore your rules", off-topic,
  prompt injection). A model from a different family (Groq `gpt-oss-120b`) grades each Gemini answer on three
  separate dimensions: grounded, complete, correct behaviour.
- **Owner report:** one self-contained HTML page per run that shows the business owner every question, the
  answer, the pages it cited and a plain-English result.
- **Read-only MCP connector:** three tools so an AI assistant can look up saved businesses and reports without
  write access (fictional-data demonstration).

## Results (owned sites, October 17, 2026)

| Measure | synqlogic.com | European Beauty Lounge site |
|---|---|---|
| Retrieval: all required facts in the top 8 chunks | 20/20 source questions | 20/20 |
| Live answers passing all three grader checks | **24/26**, 0 execution errors | **22/26**, 1 grader execution error |
| Source questions judged complete | 19/20 | 17/20 |
| Trap questions passing all grader checks | 5/6 (the sixth is the refusal below) | 6/6 |

Every failure was kept and read, not averaged away:
- Two Synq failures look like grader strictness (a correct "not on this website" refusal marked ungrounded; a
  near-identical wording of a privacy fact marked incomplete). Raw verdicts were not overridden.
- Two salon failures were real: the assistant said deals "are currently running" when the site only mentions
  them, and one answer came back from the model as a broken sentence. Fixes: an answer rule against claiming
  time-sensitive offers are active (prompt v8), and rejecting model replies that report an abnormal stop.
  Re-measurement on v8 is pending.
- Reviewing the owner report surfaced a duplicated phone number in refusals; fixed with a regression test.

## Safety and cost controls, tested against a real database

The assistant runs on free model tiers with a hard lifetime budget, so the controls that stop spending matter
more than features. On a local PostgreSQL 18.4 + pgvector instance with the production migrations unchanged:

- 24 simultaneous requests through two connections against a limit of 3: **exactly 3 accepted, 0 errors**.
- A quota stop survives a database restart. A stop that *could not* be saved during a database outage was first
  shown to be lost (a new request was accepted after recovery); after the fix (a durable local stop marker replayed
  before any reservation) the same test refuses it.
- Browser-type roles (`anon`, `authenticated`), created with Supabase-style default grants, end up with no access
  to the four server functions or the 13 tables, and real attempts to reserve or read the budget are denied.

An independent AI security review (Claude Opus) approved this gate with conditions. Its three medium findings
(no retry of an unsaved stop while the process lives, an empty database reply breaking the stop, outages using up
the call cap) were fixed and re-verified: 371 automated tests, type check and build pass.

## How I worked

I build with AI coding agents. I set the goals, acceptance criteria and limits; Claude Code and Codex wrote the
code; I ran the checks, read every failing case and decided what counted as a pass. Each finished stage has a
dated validation note with the commands actually run.

## Limits

- Two owned websites and 52 questions: small samples. The question set was reviewed by AI, not by a person, and
  the AI grader has not been calibrated against human labels.
- Local only: no public deployment, no real visitors, no paying customer.
- Database tests used direct SQL on a local server, not a hosted API layer; cross-server restarts are not covered.

## What I would do next with a real business

Run the same benchmark on their site with their own top 20 customer questions, agree on the pass bar with them,
show them the owner report, fix what fails, and only then put the assistant on their site with monitoring.
