# Changelog

## 2026-07-27

### Spotify API change tracking

- `/spotify-api-watch` skill and `pnpm api:watch` check whether Spotify changed the Web API and whether this server still conforms to it. Spotify publishes no RSS feed and no changelog index, so the watcher probes the predictable per-month changelog URLs and diffs against a reviewed set in `scripts/spotify-api-seen.json`, exiting non-zero on anything unread. Run it weekly to be alerted rather than surprised.
- First run surfaced four unreviewed changelog entries, including a May 2026 `account_id` field that supersedes `id` for account linking — which is what the `ALLOWED_EMAILS` allowlist currently keys on — and a July 2026 `QUOTA_EXCEEDED` reason on 429s, which is not worth retrying the way ordinary rate limiting is.
- README documents where API changes surface, in the order they appear: the developer forum runs days ahead of the official changelog.

### Agent instructions

- `CLAUDE.md` records the working rules for agents in this repo, chiefly that a green test suite here does not mean production works, and that changes to the Spotify client, endpoints or scopes get verified with live MCP calls.

## 2026-07-26

### All 24 tools fixed in production

Every tool was failing against the deployed Worker while all 42 tests passed. Four distinct bugs, three of them structurally invisible to the offline suite because they sat exactly where it substitutes a fake:

- The global `fetch` was stored as an instance property and called as `this.fetchImpl(...)`, giving it the wrong receiver — an "Illegal invocation" crash in workerd on every request. The test fake injects an arrow function, which has no receiver to get wrong.
- `SPOTIFY_SCOPES` was missing `user-top-read` and `user-read-recently-played`, so `get_top_items` and `get_recently_played` could never have worked. **Existing users must reconnect via `/mcp`** — a token keeps the scopes it was minted with.
- The restricted/legacy fallback only triggered on 404/405/410, but the restricted `/me/library` routes reject with 400, so library writes never fell back to the working legacy endpoint.
- Tool errors discarded Spotify's own `reason`, leaving every 4xx as a generic "try again" — which is what made the other three hard to diagnose.

### Landing page

- `/` serves install instructions for Claude Code and claude.ai instead of returning 404.

## 2026-07-25

### Deploy from CI

- Green `main` deploys to Cloudflare automatically, gated on lint, typecheck, tests and the security job.
- CI hardening: gitleaks secret scan, dependency audit, `check:meta` for code↔README tool parity and description token budgets, and a 600 KiB gzip bundle budget.
- `pnpm check` mirrors CI exactly, so a green local check means a green build. `pnpm ci:local` and an opt-in pre-push hook run the same set.
- `scripts/e2e.ts` does a live OAuth smoke test against the deployed Worker.

### Renamed to `spotify-mcp-cloudflare`

- Published at <https://github.com/jamiew/spotify-mcp-cloudflare>, deployed to `workers.dev`. The custom domain is deferred until the zone moves to Cloudflare.

## 2026-07-24

### Typed Spotify layer and 24-tool surface

- Replaced the inherited `type Json = any` client with Zod-parsed schemas and a typed endpoint module. `noExplicitAny` is enforced everywhere except the inherited `workers-oauth-utils.ts`.
- Per-family fallback between the restricted (February 2026) and legacy API regimes, cached per session, so the server works with both old and new Spotify apps.
- Full tool-surface rewrite to 24 tools with compact outputs and friendly error mapping.

### Auth hardening

- Refresh dedup, `invalid_grant` surfaced as a proper re-auth signal, and a Zod-parsed OAuth callback profile.
- `ALLOWED_EMAILS` matches on email *or* Spotify user id, since the restricted `/me` no longer returns an email.
- Worker integration tests cover OAuth discovery, dynamic client registration, 401 gating and the approval dialog.

## 2026-07-23

### Project start

- Forked from [lassejlv/spotify-mcp](https://github.com/lassejlv/spotify-mcp) (MIT) for its `@cloudflare/workers-oauth-provider` auth layer and Workers/Durable Object plumbing.
- Tool design, typed-endpoint approach and the fake-upstream test harness borrowed from [markandeyay/spotify-mcp](https://github.com/markandeyay/spotify-mcp).
- Successor to [jamiew/spotify-mcp](https://github.com/jamiew/spotify-mcp), a local Python MCP server, rewritten in TypeScript as a remote server.
- Tooling from day one, which neither base repo had: pnpm, Biome, strict `tsc`, vitest on `@cloudflare/vitest-pool-workers`, and CI.
