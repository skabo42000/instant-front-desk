# Security scope

Instant Front Desk is a prototype, not a production security claim. It has no
public deployment or customer-use evidence. See [pilot gates](docs/pilot.md).

Only approved public origins may be crawled. Fetching checks public addresses,
redirects and robots.txt, with page/body/time caps. Website text and visitor
questions are untrusted data. Answer policy, citation/number checks and injection
fixtures provide layers, not proof against every natural-language attack.

Business repositories and server-only read RPCs require business scope; composite
foreign keys prevent mixed-business relationships. Database RLS and explicit
anonymous/authenticated privilege revocation protect direct API access. A server
service-role credential is privileged: it must never enter the browser. These
checks do not establish enterprise tenant isolation or real concurrent operation.

A prepared pilot requires invitation access, exact write origins, a two-business
allowlist, shared fail-closed limits and a persistent provider-attempt budget.
There is no public ingestion, admin, SQL, billing or budget-reset endpoint.
Local memory limits and unsigned browser identity are insufficient for an open
public release; the controlled pilot also uses business/global caps and an invite.

Logs use generated request IDs and fixed reasons. They omit questions, answers,
source text, cookies, IPs, authorization and raw exceptions. Pilot invitation/origin
denials have separate metadata events. Application log behavior does not control
hosting access logs or provider retention. Keys live in ignored environment files
locally and server-only hosting settings after an approved deployment.

Report a concern privately to the repository owner with a minimal reproduction.
Do not include real secrets, customer information or attack a running business.
Pause the pilot on any suspected data leak. Independent security review and actual
Supabase concurrency/permission checks remain required before deployment approval.
