# One answer engine, four MCP tools

**Instant Front Desk · Local prototype · October 24, 2026**

I build with Claude Code and Codex. This project connects another AI assistant to a website chat's existing answer engine and saved evaluation reports. It has no customer use or deployment. [Claims and scope][claims]

## Problem

A business assistant should answer from that business's website, cite the source and refuse missing information. Another AI tool should reuse those rules and spending limits. Adding MCP should not create a second answer engine with weaker controls. [Brief](brief.md), [implementation](mcp.md)

## What it does

| Tool | Purpose |
| --- | --- |
| `list_businesses` | Find explicitly allowlisted business records. |
| `get_business` | Read public metadata and saved page/chunk counts. |
| `get_evaluation_report` | Inspect a saved legacy report, including failures and execution errors. |
| `ask_business` | Ask the existing chat engine for a cited answer or refusal. |

No tool provides arbitrary SQL, file access, ingestion or business-record edits. Answer requests consume accounting limits. [Tool contracts](mcp.md#tools-and-architecture)

## Design decisions and why

Real app: **assistant → stdio adapter → authenticated loopback HTTP → app-owned database and chat runtime**. The adapter avoids opening the app's PGlite database from a second process. [Architecture](mcp.md#tools-and-architecture)

- **Read-only and scoped.** Both sides enforce business UUID allowlists and strict schemas. The API is disabled by default, restricted to numeric loopback and unavailable in pilot mode.
- **Authenticate both sides.** Mutual HMAC challenge-response replaces sending a reusable token to whoever occupies the local port. Fresh nonces bind proofs to the origin, tool and exact request; results are signed too. The secret never travels over HTTP. This authenticates messages without encrypting them.
- **Share the budget.** Browser and MCP questions use the same chat runtime, business rate bucket and provider-call cap, including embeddings, retries and fallbacks. Local counters reset on restart.
- **Keep the answer rules.** Website text is untrusted data. Answers require supplied citations; missing evidence produces a refusal. Unsupported prices return `kind: refusal`; invalid input or infrastructure failures return a tool error. These checks cannot guarantee factual accuracy.

[Authentication and bounds](mcp.md#authentication-and-bounds), [shared answer runtime](mcp.md#tools-and-architecture)

## Security review: findings and fixes

Separate independent AI reviews found **two medium web-app issues and one medium MCP issue**. Fixes and regression tests are present. The original reviews preceded those fixes; they do not constitute release sign-off. [Web review][web-review], [MCP review][mcp-review]

| Finding | Fix and regression evidence |
| --- | --- |
| Website headings could inject instructions into model input. | Drop affected sections before selection/generation. Tests reject the review's “all services are free” heading and citations to its removed chunk. [Answer tests](../tests/unit/answer.test.ts), fix `f306865`. |
| Malformed HTML could block extraction beyond crawler deadlines. | Replace overlapping tokenizer scans with a forward scan. Regression covers 32,000 repeated `<` characters and a fake crawl with a 50 ms deadline. [Crawler tests](../tests/unit/crawl.test.ts), fix `f306865`. |
| An impostor local service could capture the adapter token. | Add mutual HMAC proofs and signed results. Tests reject impostors, tampering, replay and expired challenges. [Authentication tests](../tests/unit/mcp-auth.test.ts), fix `bfa2b66`. |

These cover concrete attacks, not every prompt injection or hostile local process.

## Evidence

- **Offline engineering, October 24:** the engineer recorded **587 tests passed, 1 skipped across 47 files**, plus a passing final typecheck. These are project-wide counts; they were not rerun for this writing update. [Engineer result][engineer]
- **Stdio end to end:** an official-SDK client starts a real child process, discovers four tools and checks six exchanges: metadata, a saved report, a cited Saturday-hours answer, an exact-price refusal and rejected empty input. The HTTP transport is injected in-process; TCP and Next.js routing are outside this test. [Integration test](../tests/integration/mcp-stdio.test.ts), [demo transcript](mcp-demo-transcript.md)
- **Assistant tool choice:** on October 16, a Codex assistant selected all three tools then available over fictional data and recovered from rejected input. The new four-tool demo is scripted. [Historical evidence][claims]
- **Approved quality baseline, October 17:** on 26 questions per owned site, Synq passed **24/26** with no execution errors; European Beauty Lounge passed **22/26**, with one grader execution error. Gemini answers were graded for grounding, completeness and correctness by a separate model family through Groq. Questions were AI-reviewed; scores remain provisional, without established human-calibrated accuracy. These are separate answer benchmarks, not MCP demo scores. [Dated baseline and limits][claims]

## Limits

Local prototype, built with AI coding agents. No production or customer-use evidence. Scripted models and token-hash embeddings demonstrate protocol behavior rather than real-model quality. TCP loopback, Claude GUI setup, hosted CI execution and deployment readiness remain outside the engineer's completed checks. [Engineer result][engineer], [pilot gates](pilot.md)

Tracked benchmarks contain public website text and embeddings from Synq Logic and European Beauty Lounge, kept as realistic evaluation fixtures with the owner's approval (2026-10-25). They contain no visitor conversations, customer records or credentials. [Privacy limit](mcp.md#verification-and-remaining-limits)

## Run the two-minute demo

With Node 22+ and locked dependencies installed using `npm ci`:

```sh
npm run mcp:demo
```

No keys, saved database or network listener are needed. The session uses disposable in-memory PGlite, prints results, writes the [transcript](mcp-demo-transcript.md) and closes its child process. Dependency installation needs a registry or cache. [Setup and transport limits](mcp.md#two-minute-fictional-demo)

[claims]: evidence/security-reviews-2026-10-24.md#claims-and-scope
[engineer]: evidence/security-reviews-2026-10-24.md#portfolio-engineering
[web-review]: evidence/security-reviews-2026-10-24.md#web-app-review
[mcp-review]: evidence/security-reviews-2026-10-24.md#mcp-review
