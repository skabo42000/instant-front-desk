# Sanitized evidence summary

October 24, 2026 (America/Chicago). Local prototype built with AI coding agents;
no customer use or deployment. This summary preserves findings, fixes and recorded
checks without private run metadata or configuration. Historical results below
are attributed records, not fresh executions or independent release approval.

## Web app review

Independent offline AI review of revision `dd891d6` found two medium issues:

- Website headings could carry instructions into model input. A synthetic
  heading bypass and scripted incorrect answer were reproduced; real-model
  obedience was not tested. Fix `f306865` drops instruction-bearing sections
  before selection/generation and prevents citing their removed chunks.
  [Answer regressions](../../tests/unit/answer.test.ts).
- Repeated `<` characters caused overlapping HTML scans to block beyond crawl
  deadlines. Synthetic extraction and a fake crawl reproduced the delay.
  Fix `f306865` uses a forward scan; regressions cover 32,000 characters and
  a fake crawl with a 50 ms deadline. [Crawler regressions](../../tests/unit/crawl.test.ts).

The review did not run the full suite or typecheck. The fix commit records
**566 tests passed, 1 skipped**, and a clean typecheck. Those are historical
maintainer verification counts, not reviewer-run results. The original review
withheld security sign-off pending correction and recheck. Hosted permissions,
actual TLS/browser behavior, live providers and current advisories were unverified.

## MCP review

Independent offline AI review of revision `f306865` found one medium issue:
an impostor loopback service could capture the adapter's reusable token.
An injected in-memory HTTP simulation reproduced capture of a synthetic token;
actual cross-user port takeover and replay were inferred, not executed.

Fix `bfa2b66` adds mutual HMAC challenge-response, fresh nonces and signed results
bound to the origin, tool and request. The reusable secret is never sent to the
listener. [Authentication regressions](../../tests/unit/mcp-auth.test.ts) reject
impostors, tampering, replay and expired challenges.

The review executed **33 handler checks, 6 invalid-origin checks and 9 SDK adapter
rejection scenarios**, plus pagination/redaction/body-limit checks and the
impostor simulation (no aggregate count recorded). It ran no fresh full suite or
typecheck. The fix commit records **576 tests passed, 1 skipped**, and a clean
typecheck. Actual sockets, Next.js HTTP routing and hostile-process isolation
were outside the review; the original finding is not a post-fix release sign-off.

## Portfolio engineering

The subsequent four-tool implementation record reports **587 tests passed,
1 skipped, 588 total across 47 passing files**, plus a passing final typecheck.
An earlier typecheck failed on a test-helper argument and was corrected. These
are historical engineer results; hosted CI, clean-clone installation and Node 22
execution were not verified (the recorded local runtime was Node 24.21.0).

The fictional demo used disposable in-memory PGlite, injected HTTP and a real
stdio child process: four discovered tools and six exchanges, including a cited
answer, missing-price refusal and invalid-input rejection. No external provider
or network service was contacted. [Integration test](../../tests/integration/mcp-stdio.test.ts),
[transcript](../mcp-demo-transcript.md). TCP loopback and GUI assistant behavior
remain unverified. Existing tracked owned-site fixtures remain a publication
decision; this summary does not resolve that gate.

## Claims and scope

- Historical October 16 assistant demonstration: a Codex assistant selected the
  three tools then available over fictional data and recovered from rejected
  input. Recorded implementation: `984206e`. The four-tool demo is scripted.
- Approved October 17 answer baseline: 26 AI-reviewed questions per owned site;
  Synq passed 24/26 across grounding, completeness and correctness with no
  execution errors; European Beauty Lounge passed 22/26 with one grader error.
  Gemini answers were graded through Groq by a separate model family. Recorded
  baseline revision: `7eac0b5`. These are provisional answer benchmarks, separate
  from MCP protocol checks; human-calibrated accuracy remains unverified.
- No production, customer-use or independent coding-skill claim follows from
  these artifacts. [Project scope](../brief.md), [pilot gates](../pilot.md).
