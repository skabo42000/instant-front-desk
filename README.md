# Instant Front Desk (working name)

Prototype, 2026-10-10. Nothing is built beyond the scaffold and offline harness.
See `docs/brief.md` for the goal, scope and current decisions.

Included: a Next.js App Router page, TypeScript, Tailwind, server-only configuration,
shared types, a scripted fake model, Vitest, and two fictional website fixtures.
There is no crawler, database, retrieval, working chat, score card or real provider adapter yet.
There are no customer results, real-site evaluations or deployment evidence.

## Local setup

Use Node.js 22 LTS or newer (the scaffold was checked with Node.js 24.21.0).

```powershell
npm install
npm run dev
```

Open http://localhost:3000. Fake mode is the default and needs no keys, database or accounts.
Tests run offline after dependencies are installed:

```powershell
npm run typecheck
npm run test
npm run build
```

## Settings

`.env.example` contains variable names with empty values. Optional local settings belong
in the ignored `.env.local`; never paste credentials into chat or commit them.
`MODEL_MODE=fake` uses no credentials. `MODEL_MODE=real` validates `DATABASE_URL`,
`GEMINI_API_KEY`, `GEMINI_EVAL_API_KEY` and `GROQ_API_KEY`. Evaluation and answer keys
must differ. Real mode is configuration validation only; it does not enable real calls.
Database URLs must use `postgres://` or `postgresql://`. Errors list settings, not their values.
Keys are never named `NEXT_PUBLIC_*`. The page passes only the mode to the client component;
configuration and fake model modules are marked `server-only`.

Per the brief's 2026-10-10 decisions: Gemini answers/embeddings, Groq (Llama family) judges
and answer fallback. Provider free tiers and readiness remain unverified. No paid calls or
automatic billing fallback are implemented.

## Offline test set and limits

The unit tests cover fake/real configuration, missing keys, invalid settings, client props,
rendered client output, and scripted reply order/exhaustion/isolation. Vitest substitutes
an empty `server-only` module because it runs outside Next; Next enforces that import boundary
in application builds. The props test checks the actual allowlist and client rendering; it
is not a general secret scanner or proof about future components.

`tests/fixtures/bright-salon` has hours, contact details, services without prices, and robots.txt.
`tests/fixtures/maple-repair` omits hours/prices and contains an intentional prompt-injection
string as untrusted test data. These are files for later crawler tests, not live sites;
no crawling or prompt-injection protection has been tested at this milestone.
The fake model returns supplied replies without network calls. It does not generate answers,
retrieve sources or validate grounding.

Verification on 2026-10-10 (run by the coordinator after `npm install`): `npm run typecheck` passed,
`npm run test` passed (12 tests in 2 files), and `npm run build` passed. These are offline checks of the
scaffold only; nothing has been tested against a real site or a real model.

Beginner explanation: server settings stay on the server; the browser receives just a small
safe object. The fake model lets later tests supply predictable answers without paying a provider.
Exercise: add a test for `MODEL_MODE=real` with only `GEMINI_EVAL_API_KEY` missing, predict the
error, then run `npm run test -- tests/unit/config.test.ts`. This is practice, not proof of mastery.
