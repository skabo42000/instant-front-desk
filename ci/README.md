# CI workflow (ready to enable)

`github-actions-offline-checks.yml` runs `npm ci`, typecheck and the full offline test suite
(including the fictional real-stdio MCP integration test) on Node 22, with no secrets.

It lives here because the publishing account's token lacked GitHub's `workflow` scope on
2026-10-25. To enable it, move it to `.github/workflows/ci.yml` and push with a token that has
the `workflow` scope. Until then, the same checks were run from a clean clone on the
maintainer's Mac before publication.
