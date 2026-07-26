# PLAN — spotify-mcp-cloudflare

> **Graduated 2026-07-26:** the project now lives at `~/dev/spotify-mcp-cloudflare` / [github.com/jamiew/spotify-mcp-cloudflare](https://github.com/jamiew/spotify-mcp-cloudflare), deployed at <https://spotify-mcp-cloudflare.jamie-7e9.workers.dev> with CI auto-deploy. This workspace remains as the survey archive (21 cloned repos + README) and historical plan. Remaining work (recommendations v2, custom domain) tracked below.

## Exec summary

Build a new remotely-hosted Spotify MCP on **Cloudflare Workers**, starting from `spotify-mcp-lassejlv` (its `@cloudflare/workers-oauth-provider` auth layer and Workers/Durable Object plumbing), porting the **tool designs, typed endpoint layer, and response-shaping discipline from `spotify-mcp-markandeyay`**, and standing up aggressive testing (vitest + fake-Spotify harness) and linting (Biome + strict tsc + CI) from day one — neither base repo has any. Feature target: jamiew's core workflows (playlist manipulation; artist/track/album lookups; recommendations rebuilt for the post-`/recommendations` API) plus markandeyay's insight tools.

**Status (2026-07-26):** live-tested end to end against the deployed Worker for the first time — 21 of 24 tools verified with real MCP calls. Four production bugs surfaced that the 42-test suite passed clean over: (1) global `fetch` stored as an instance property and called as `this.fetchImpl()`, which throws "Illegal invocation" in workerd and broke *every* tool; (2) `SPOTIFY_SCOPES` missing `user-top-read` + `user-read-recently-played`, so those two tools could never have worked; (3) `withFallback` only retrying on 404/405/410 when the restricted `/me/library` routes reject with **400**, so library writes never fell back; (4) `mapError` discarding Spotify's `reason`, which is what made the first three hard to diagnose. All fixed, pushed, CI green, deployed.

Three playback tools (`add_to_queue`, `control_playback`, `transfer_playback`) remain unverified — they need an active Spotify device; their no-device error path is confirmed good. Also observed: Spotify reports playlists as `public: true` regardless of what we send on create *or* update — upstream reporting quirk, not ours, don't chase it.

The lesson worth keeping: all three functional bugs lived exactly where the suite substitutes a fake (injected arrow-function `fetch`, an unexercised scope list, a fallback threshold no test drives with a real 400). High coverage, false confidence. Prefer real infra over mocks; where a fake is unavoidable, treat everything behind it as untested and cover it with `scripts/e2e.ts` instead. Wiring that script at the deployed Worker on a CI schedule is the natural next step.

**Status (2026-07-24):** Phases 0–5 essentially done (5 commits). 42 tests + lint + strict typecheck green; `wrangler deploy --dry-run` builds. 24 tools on a fully typed layer — `type Json = any` is dead, `noExplicitAny` enforced everywhere except the inherited `workers-oauth-utils.ts`. The client auto-falls-back between restricted (Feb 2026) and legacy endpoint shapes per family (`/playlists/{id}/items`⇄`/tracks`, `POST /me/playlists`⇄`/users/{id}/playlists`, `/me/library`⇄`/me/tracks` writes) and caches the answer per session, so it works with both old and new Spotify apps. `ALLOWED_EMAILS` entries now match email *or* Spotify user id (restricted `/me` has no email). Remaining: recommendations v2, deploy, rename. Notes: `@cloudflare/vitest-pool-workers` 0.18 dropped `defineWorkersConfig`/`fetchMock` — use the `cloudflareTest` vite plugin and an injectable `fetchImpl` fake; importing a `.test.ts` from another test file double-registers its tests (share helpers via a non-test module).

## TODO

- [x] Phase 0 — scaffold `spotify-mcp-cloudflare/` from lassejlv, fresh git, deps, typecheck
- [x] Phase 1 — tooling: Biome, strict tsconfig additions, vitest + workers pool, CI workflow
- [x] Phase 2 — typed Spotify layer (`src/spotify.ts` client + `src/types.ts` zod schemas + `src/endpoints.ts`)
- [x] Phase 3 — tool surface: 24 tools, compact mappers, friendly error mapping, tests per group
- [x] Phase 4 — auth hardening: refresh dedup, `invalid_grant` → re-auth message, allowlist by email-or-id, zod-parsed callback profile, worker integration tests (discovery/DCR/401/approval)
- [x] Phase 5 — 2026 API survival: per-family restricted⇄legacy fallback with session caching (subsumes regime detection; capability-degradation registry deemed unnecessary — fallback + friendly 404 message covers it)
- [ ] Phase 6 — recommendations v2 (insight-driven, since `/recommendations` is gone): `get_top_items` + `get_recently_played` landed as the measured foundation; `recommend_tracks`/summarize tools still to design
- [x] Phase 7 — deployed: <https://spotify-mcp-cloudflare.jamie-7e9.workers.dev/mcp> (jamie's Spotify app + KV + secrets). Custom domain deferred: jamiedubs.com DNS is on Namecheap, route stashed in wrangler.jsonc. `scripts/e2e.ts` (pnpm e2e) does the live OAuth smoke test — jamie to finish the browser approval
- [x] CI hardening: gitleaks + pnpm audit (security job), check:meta (code<->README tool parity + description token budgets), check:size (600 KiB gzip cap), markdownlint; deploy job needs all three + DEPLOY_ENABLED repo var + CLOUDFLARE_API_TOKEN secret (both still to set)
- [x] Rename to `spotify-mcp-cloudflare`, public repo at <https://github.com/jamiew/spotify-mcp-cloudflare> (created; push pending confirmation)
- [ ] Optional: elicitation gating for destructive ops (unfollow_playlist, remove_*)
- [ ] Live smoke test in CI — point `scripts/e2e.ts` at the deployed Worker and run it on a schedule; the fake-upstream suite structurally cannot catch the bug class found on 2026-07-26
- [ ] Verify `add_to_queue` / `control_playback` / `transfer_playback` against a real active device

## Phase 0 — Scaffold ✅

`spotify-mcp-cloudflare/` = copy of `spotify-mcp-lassejlv` minus its git history, fresh `git init`, pnpm. Inherited: `src/index.ts` (McpAgent + 16 tools), `src/spotify-handler.ts` (upstream OAuth flow + approval dialog), `src/workers-oauth-utils.ts` (CSRF cookie helpers), `src/spotify.ts` (API client), `src/utils.ts`, `wrangler.jsonc` (DO + KV bindings). The KV namespace id in `wrangler.jsonc` is lassejlv's — must be replaced in Phase 7.

## Phase 1 — Tooling (testing + linting first, as requested)

- **Biome**: `biome.json` with recommended rules + import sorting; `pnpm lint` / `pnpm format`.
- **tsconfig**: add `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes` (markandeyay's settings). Expect and fix fallout in inherited code.
- **vitest** with `@cloudflare/vitest-pool-workers` so tests run in workerd with real KV/DO bindings (miniflare-backed).
- **Fake Spotify upstream** (port of markandeyay `test/helpers/`): an in-test fetch handler serving canned Spotify responses + a fake `accounts.spotify.com` token endpoint. All tests offline; assert zero real network.
- **CI**: GitHub Actions — `pnpm lint && pnpm type-check && pnpm test`. Add before any porting so every phase lands green.
- First tests: characterization tests for the 16 inherited lassejlv tools against the fake upstream (locks behavior before refactoring), plus an OAuth flow test through `workers-oauth-provider` (authorize → approval → callback → token, PKCE).

## Phase 2 — Typed Spotify layer

Replace `src/spotify.ts`'s `type Json = any` with a typed endpoint module modeled on markandeyay `src/spotify/endpoints.ts`:

- One `spotifyFetch(token, path, init)` core honoring `Retry-After` (bounded — never sleep 60s in-request like markandeyay does), classifying errors (auth vs transient vs capability-removed).
- Zod schemas for the response shapes we actually consume (parse-don't-assert, no `as` casts — align with markandeyay's compact shapes).
- Keep lassejlv's caller-supplied `getToken()` closure pattern so the client stays stateless per-request.

## Phase 3 — Tool surface (the merge)

Target ~20 tools = markandeyay's design language (consolidated, compact outputs, capped scans with disclosure notes) ∪ jamiew's workflow needs ∪ lassejlv's gaps:

| Tool | Source | Notes |
| --- | --- | --- |
| `search_music` | markandeyay | replaces lassejlv `search`; honest per-type shapes (fixes jamiew's Track-coercion bug) |
| `get_track_details` / `get_artist_details` / `get_album_details` | markandeyay | batch ids; artist includes top-tracks/albums; **new vs lassejlv** |
| `list_playlists`, `get_playlist` (raw\|summary) | markandeyay | summary mode = server-side aggregates |
| `create_playlist`, `add_tracks_to_playlist`, `remove_tracks_from_playlist`, `reorder_playlist` | markandeyay | keep lassejlv handler bodies where equivalent |
| `update_playlist_details` | lassejlv | markandeyay lacks it; jamiew has it — keep |
| `unfollow_playlist` | lassejlv | keep (destructive: mirror jamiew's confirm gating if client supports elicitation) |
| `get_saved_tracks`, `save_items`, `remove_items` | markandeyay | multi-type (tracks/albums) |
| `get_playback_state`, `control_playback` | merge | markandeyay enum **plus shuffle/repeat** (its known gap) |
| `queue_tracks` | markandeyay | batch, but cap + parallelize (its 20-sequential-call issue) |
| `get_queue` | jamiew | only jamiew has it; port |
| `list_devices`, `transfer_playback` | markandeyay | new |
| `get_recently_played` | markandeyay | feeds recommendations v2 |
| `summarize_playlist`, `summarize_library`, `summarize_listening_trends`, `find_library_gaps` | markandeyay | the insight suite; measured-vs-inferred labeling |
| `get_initial_context` | markandeyay | orientation tool; include capability/regime status |

Porting mechanics: markandeyay handlers take `ctx.client` (Express/PG world) — rewire onto Phase 2's Workers client; drop its Postgres cache layer (use Workers `caches`/KV with TTLs where a cache matters, skip otherwise); keep `ok()`/`toolError()`/`runTool` helper shape and `compactTrack` mappers near-verbatim. Every ported tool group lands with fake-upstream tests.

## Phase 4 — Auth hardening (lassejlv layer, verified issues)

- Surface `invalid_grant` on refresh as a proper MCP auth error (401 + `WWW-Authenticate`) so clients re-auth instead of showing an opaque tool error.
- Refresh-promise dedup per session (thebigredgeek's `token-manager.ts` pattern) — DO alarms/state make this easy.
- Note (verified non-issue): fresh Durable Object per MCP initialize means re-auth always seeds fresh tokens; grant props keeping the original access token just means one refresh on first use.
- Tests: refresh-on-expiry, refresh preserves rotating/non-rotating refresh tokens, revoked-grant → 401 path.

## Phase 5 — 2026 API survival

- Port marcelmarais `spotifyFetch` migrations (`/playlists/{id}/tracks`→`/items`, `POST /me/playlists`, library DELETE bodies) into the Phase 2 client.
- Capability registry (markandeyay): on shape-identifiable "endpoint removed" errors, mark capability degraded in DO state; tools answer with one friendly note thereafter.
- Regime detection (marc1201): probe `/markets` once per session to classify FULL vs RESTRICTED dev-mode; store on DO; pin request shapes with regression tests.

## Phase 6 — Recommendations v2

`/recommendations`, audio-features, and related-artists are dead for new apps, so rebuild jamiew's "custom recommendation stuff" server-side from what still works:

1. **Taste profile**: `summarize_library` + `summarize_listening_trends` + `get_recently_played` → artist/era/genre distribution (measured, labeled as such).
2. **Candidate generation**: model proposes queries/artists → `search_music` + artist top-tracks fan-out (bounded).
3. **Ownership filter**: `find_library_gaps`-style contains-check so recs exclude what's already saved.
4. Expose as one `recommend_tracks` tool (profile + candidates + filter in one call, compact output) — details to design when we get here; jamiew's old heuristics worth reviewing first.

## Phase 7 — Deploy & verify

- New Spotify app (dashboard): redirect URI `https://<worker>.workers.dev/callback`; allowlist jamie (+up to ~4 others — dev-mode cap).
- `wrangler kv namespace create OAUTH_KV` (replace lassejlv's id), secrets: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`.
- `wrangler deploy`; connect from Claude Code (`claude mcp add --transport http`) and claude.ai custom connector; verify full OAuth dance + a playlist round-trip.

## Open questions

1. Project name (currently `spotify-mcp-cloudflare`).
2. Keep lassejlv's optional email allowlist gating? (Cheap defense-in-depth on top of Spotify's own allowlist — lean yes.)
3. SSE legacy endpoint: keep (`McpAgent` gives it free) or Streamable-HTTP-only?
4. Elicitation gating for destructive ops (jamiew's pattern) — depends on client support over Streamable HTTP; test in Phase 3.
