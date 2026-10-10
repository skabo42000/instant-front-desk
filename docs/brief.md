# Instant Front Desk: project brief

Working name (placeholder). Created 2026-10-10 from Bosko's request. Owner: Bosko (Synq Logic).

## Goal
Paste a business's website address. A few minutes later there is a working AI assistant that answers visitors'
questions using ONLY that website's content, a score card that shows how well it answers, and a shareable page.
Version 1 is a text chat. Voice (Vapi, same answer engine) comes after v1 works.

Two audiences:
- **Owners (Synq Logic customers):** "Try an assistant that already knows your business." Also cuts setup time for a
  paying client. Customer-facing wording: plain English, no tech jargon.
- **Recruiters (FDE / AI solutions roles):** evals on real data, grounded answers and refusals, prompt-injection
  safety, Postgres + vector search, deployed online, cost and latency tracking.

## Scope of v1 (local first, nothing public until it works)
1. **Ingest:** URL in, crawl public pages of the same site only (cap ~15 pages), respect robots.txt, extract clean
   text, split by heading into chunks, embed, store per business in Postgres (pgvector).
2. **Answer:** retrieve relevant chunks, answer only from them, cite the page. If the site does not say, say so and
   give the phone number/contact found on the site. Never invent prices, hours, services or policies.
3. **Safety:** website text is untrusted DATA (it may contain instructions: ignore them). Block private/internal
   addresses when fetching (no server-side request forgery). Rate-limit the chat. Cap crawl size and time.
4. **Score card:** auto-generate ~20 test questions from the site plus ~6 trap questions (answer not on the site,
   price not listed, prompt injection, off-topic, competitor question, "ignore your rules"). Run them, judge each
   answer (judge uses a different model family from the answerer), show X/Y with every failure listed. The owner can
   edit the question list (human review).
5. **Share page:** `/b/<slug>` with the chat and the score card. Embeddable widget is a later step.
6. **Model gateway:** cheap model by default, automatic fallback to another provider, timeouts, retries, cost and
   latency logged per request.

Out of scope for v1: voice, owner login/billing, embeddable widget, multi-page admin, sending anything to anyone.

## Stack (decided unless the read-only plan finds a real problem)
Next.js (App Router) + TypeScript + Tailwind; Postgres with pgvector on Supabase free tier (verify current free-tier
limits); Gemini embeddings and a cheap Gemini model for answers; a different family (Claude) as judge; Vercel later.
Develop and test locally first with offline tests (fake sites, fake model responses) so tests cost nothing.
`tenant`/`business_id` on every table.

## Acceptance criteria
- A test URL (Bosko's own sites first: European Beauty Lounge, synqlogic.com) becomes a working chat locally.
- Offline test suite passes (crawler limits, robots.txt, private-address blocking, chunking, retrieval, refusal,
  injection fixtures, score card logic). Commands actually run and reported.
- Score card on at least 2 real sites with the question list, answers, judge verdicts and failures saved as a report.
- Judge checked against a small set of hand-labelled answers (target: report agreement honestly, any size).
- No secrets in files. `.env.local` ignored. A separate Gemini key for evals (the main key backs live chat widgets).
- README honest: prototype, what the test set was, date, limits. No customer claims.

## Rules
- Free tiers only. Anything that spends money needs Bosko's approval.
- Do not contact, email or message any real business. Prospect sites are used only after Bosko approves, and only
  public pages.
- Claims stay "prototype" until a real business uses it.
- Setup steps for Bosko (dashboard clicks) must be few and listed exactly; do the rest via CLI/API.
