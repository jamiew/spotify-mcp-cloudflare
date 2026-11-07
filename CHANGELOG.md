# Changelog

## 2026-11-07 — 0.9.3

- Waiting for a Spotify token now honors the same cancellation and 15 second deadline as Spotify requests, on the Worker and local stdio alike. Before, a stalled token fetch or refresh kept a cancelled call pending. Only the wait ends: a local refresh that answers after the caller gave up still saves its rotated refresh token.

## 2026-11-07 — 0.9.2

- The local stdio server starts without `SPOTIFY_CLIENT_ID` or a prior login, so clients, registries and headless `.mcp.json` runs can initialize it and list tools. Tool calls that need Spotify return "Spotify isn't set up for this local server. Set SPOTIFY_CLIENT_ID, run pnpm run login, then restart the server." An unconfigured server holds no lock on the token store, so `pnpm run login` works while it runs. `login` still requires `SPOTIFY_CLIENT_ID`, and a mismatched or under-scoped stored login still stops startup.

## 2026-11-07 — 0.9.1

- Cancelling a tool call now stops its Spotify request. The MCP request's abort signal reaches every upstream `fetch` and any `Retry-After` wait. Each Spotify attempt also has a 15 second deadline; a timed-out call reports "The request timed out. Try again shortly." Stateless 2025-era HTTP clients can't deliver cancellation to the running request, so only the deadline applies there.
- `set_playlist_cover` no longer buffers the whole image before checking its size. It refuses a declared `Content-Length` over 192 KB without reading the body, streams the rest and stops as soon as it passes 192 KB, and gives up on a download that outlives the deadline. The oversize error now counts raw bytes (192 KB), not base64 (256 KB).
- `check:meta` lists tools and prompts through an in-process MCP client instead of matching source with regexes. It keeps the README name check and the description budgets, and drops the README tool count. `@modelcontextprotocol/client` moves to `devDependencies`; only tests and scripts import it, and the Worker bundle is unchanged.

## 2026-11-07 — 0.9.0

- **MCP SDK v2, stateless Worker.** `McpAgent`, MCP SDK v1 and the Durable Object are gone. `/mcp` now runs `createMcpHandler` from `agents` 0.33 on `@modelcontextprotocol/server` 2.4. It speaks the 2026-07-28 revision and still serves 2025-era clients, each request on a fresh server. Local stdio moves to `serveStdio` and negotiates either era too. The gzipped Worker drops from 712 KiB to 308 KiB.
- **The OAuth grant owns the Spotify tokens.** Before, each MCP session's Durable Object refreshed its own copy. Now the provider's token exchange callback renews Spotify when a client refreshes and writes the result back to the grant, so every session of a grant shares one refresh chain, including a rotated Spotify refresh token. MCP access tokens expire five minutes before the Spotify token they carry. A request whose Spotify token has already lapsed (grants from before this release) gets a 401 that makes the client refresh. Spotify `invalid_grant` revokes the grant; a Spotify outage returns `temporarily_unavailable` and keeps it. A removed allowlist account is revoked at its next refresh.
- **Sign in again if you used `/sse`.** `workers-oauth-provider` 1.2 binds every token to one resource, now `<origin>/mcp`. The deprecated HTTP+SSE endpoint is removed; grants made through it get `invalid_grant` and sign in once. Grants made through `/mcp` keep working. The `v2` Wrangler migration deletes the old `SpotifyMCP` Durable Object class and its per-session token copies on deploy.
- **Removal confirmation uses `input_required`.** `remove_tracks_from_playlist` returns an elicitation request instead of pushing one, so it works over stateless HTTP for 2026-07-28 clients and over stdio for both eras. A bare `elicitation: {}` capability now counts as form support, as the spec says. 2025-era clients on the remote Worker can't be asked and remove directly, as clients without elicitation always have.
- Endpoint regime answers are now shared across requests in a Worker isolate instead of per session, since the regime belongs to the app.
- Tests drive the real tool surface on three lanes (2026-07-28 over HTTP, 2025 over stateless HTTP, 2025 with a session) and the Worker end to end in workerd with real grants, refreshes and revocations. `pnpm e2e` checks both lanes live.
- Dependencies at their latest: `workers-oauth-provider` 1.2.4, `agents` 0.33, `hono` 4.13.16, `wrangler` 4.158, `vitest` 5.1, `@cloudflare/vitest-plugin` 1.6, `markdownlint-cli2` 0.24. Compatibility date 2026-10-23 and an ES2024 TypeScript target. `pnpm audit` is clean; pnpm overrides patch `re2js` and `katex` (dev-only, via `markdownlint-cli2`) and the `@hono/node-server` audit exception is gone. Supersedes #22.
- A failed approval form on the Worker answers "Internal server error" without echoing the internal error text.
- `.mcp.json` adds `spotify-local`, which runs this checkout's stdio server with its own `tsx`, so it doesn't depend on how pnpm is installed. A Node test launches that exact entry with synthetic tokens on both protocol eras and fails any tool without `readOnlyHint`, or a writing tool without `destructiveHint`. It replaces the regex check in `check:meta`.
- Cleanup: one `writeLibrary` replaces seven near-identical library write functions with the same requests, and unused exports, the `clamp` helper and test-only client options are gone. The `build_playlist` README row and the icon script comment match what the code does now.

## 2026-11-01 — 0.8.0

- Playback controls and `add_to_queue` no longer report "unexpected shape" after Spotify did the action. Spotify now answers player writes with HTTP 200 and an opaque plain-text body, and the client tried to parse it as JSON. Writes no longer read the response body; reads still validate theirs.
- A rejected request (HTTP 400 and other 4xx) no longer says "Try again shortly". The error passes Spotify's reason through, such as "Invalid base62 id". Only 429 and 5xx errors suggest retrying.
- **Reconnect once after upgrading.** The server now asks for `user-read-playback-position` so episode lists can include resume points. Remote users reconnect the MCP server; local users run `pnpm run login` again.
- Podcast and audiobook library tools, matching the Python edition: `get_saved_shows`, `save_shows`, `remove_saved_shows`, `get_show_episodes` (with resume points), `get_saved_episodes`, `save_episodes`, `remove_saved_episodes`, `get_saved_audiobooks`, `save_audiobooks` and `remove_saved_audiobooks`. `check_library` takes `show`, `episode` and `audiobook`. Writes use `/me/library` and fall back to the legacy per-kind routes like the other library writes.
- `get_playback_state` and `get_queue` describe a playing podcast episode (`type: "episode"`, the show as `artist`) instead of `track: null`.
- `control_playback play` and `add_to_queue` keep episode URIs and links. A bare ID is still a track. Albums, shows, artists and playlists are refused as items, with a pointer to `context_uri`. Playing an episode is best effort: Spotify has accepted the request and left the player idle.
- Audiobooks go to `/me/library` as `spotify:show:` URIs, because Spotify answers 5xx to `spotify:audiobook:` there. The legacy `/me/audiobooks` routes stay as the fallback.
- `agents` 0.23 → 0.32. `McpAgent` still runs on MCP SDK v1; since 0.31 `agents` no longer installs it, so `@modelcontextprotocol/sdk` 1.32.2 and `@modelcontextprotocol/server` 2.4.0 are pinned to the versions it expects. The pnpm overrides for its old MCP SDK v2 and `vite` are gone. Tests move to vitest 5 and `@cloudflare/vitest-plugin`, the renamed `@cloudflare/vitest-pool-workers`. `workers-oauth-provider` stays on 0.10: 1.x binds every token to one resource, and this Worker advertises three (`/mcp`, `/sse` and the bare origin), so its grants can carry any of them.

## 2026-11-01 — 0.7.2

- `get_playlist` no longer fails on a playlist that holds a podcast episode. It now asks Spotify for episodes and lists them with `type: "episode"` and the podcast name as the artist.

## 2026-11-01 — 0.7.1

- Playlists, playback and the queue no longer fail when they hold a local file. Spotify sends its album with a null id, which the schema rejected.
- `control_playback play` sends only `context_uri` when both it and `uris` are given, as documented; Spotify rejects both with 400. `context_uri` now accepts share links, and legacy `spotify:user:x:playlist:y` URIs normalize to a playlist.
- `get_playback_state` reports active playback of a podcast episode or ad with `track: null` instead of "No active playback."
- Cover art docs give the real limit: a 192 KB JPEG, since Spotify's 256 KB cap applies after base64 encoding.
- Dependencies refreshed within their major versions (MCP SDK 1.32, `workers-oauth-provider` 0.10.4, `hono` 4.13, `wrangler` 4.156). pnpm overrides move `agents`' bundled MCP SDK v2 to 2.3.1 and `vite` to 8.3, which clears the dependency audit again (#11).

## 2026-09-20 — 0.7.0

- Local stdio and the existing Worker share the canonical TypeScript tool/API core; explicit PKCE login stores private, atomically replaced tokens with refresh rotation and single-owner locking.
- Tools publish output schemas, accept search offsets and snapshot guards, and support bounded playlist pagination with progress. Playlist removal uses form elicitation when the client supports it.
- Long `Retry-After` values are surfaced rather than shortened; quota errors no longer promise an undocumented daily reset.
- Upstream OAuth error bodies are not exposed to callers or logs; revoked grants still trigger reauthorization.
- Local setup and recovery instructions use `pnpm run login` so pnpm runs Spotify login instead of its built-in package-registry command.
- Invalid OAuth clients and redirect URIs return a local client error rather than HTTP 500; protocol error redirects use only destinations validated by the OAuth provider.
- The live e2e script preserves stale redirect registrations in exclusive, mode-0600 backups before requiring a fresh registration and browser authorization.
- Validate playlist-removal confirmations without dynamic code generation, which Cloudflare Workers blocks.
- Keep the e2e credential cache and its backups out of formatter and linter output.
- Simplify local and hosted setup documentation and add a README banner made with Glif.
- Documentation records the [July quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates), [postponed endpoint rollout](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security), remaining Python differences and [AI/public-hosting policy constraints](https://developer.spotify.com/policy). Public enrollment and an SDK major migration remain out of scope.
- A 429 carrying `QUOTA_EXCEEDED` is no longer retried; quota is shared per developer account, so an exhausted quota is surfaced immediately (#2).
- The `ALLOWED_EMAILS` allowlist also matches Spotify's immutable `account_id` (#3).
- Local redirect URIs use `127.0.0.1`; Spotify rejects `localhost` (#8).
- `.mcp.json` registers the deployed server for anyone running Claude Code in a clone (#9).

## 2026-09-17 — 0.6.1

- **Batch reads.** `get_tracks` (was `get_track_details`), `get_artist` and `get_album` read up to 50 IDs (20 for albums) in one request instead of one request each. Restricted apps get a 403 from that route while single reads still work, so it falls back to one request per ID and remembers the answer, the same way `withFallback` remembers a regime. A single ID never touches the batch route.
- **Deploys had silently stopped.** CI's dependency audit went red on 6 Aug over transitive `fast-uri`, `ip-address` and `nanoid` advisories, and the deploy job depends on it, so nothing after 0.4.0 reached the Worker, including the icon fix above. Two packages moved within their ranges; `nanoid` needed a `pnpm` override because `postcss` had resolved it below the patched line.
- **Dependencies brought current.** `agents` 0.23 (McpAgent is deprecated upstream but supported), MCP SDK 1.30, `workers-oauth-provider` 0.10 (OAuth 2.1: S256 PKCE is now required for public clients), `hono` 4.13 and friends. The audit is clean at every level. `agents/mcp` now bundles MCP SDK v2 next to v1, so the size budget rose to 800 KiB until we move to v2 only. `vitest` 5 waits on `vitest-pool-workers`.
- **`check_library`.** Says whether tracks or albums are saved and artists followed, up to 40 IDs per call. Before this, "do I already have these?" meant paging the whole library. Restricted apps serve one `/me/library/contains` route keyed by URI; legacy apps keep one route per kind, so it falls back like the library writes do.
- **Housekeeping.** The tool surface moved to `src/tools.ts` and is now tested in-process over an MCP transport (60 tests, up from 42). The inherited 690-line OAuth utils became a 264-line `src/consent.ts` with no `any`. `scripts/ci-local.sh` and the `start`, `cf-typegen` and `ci:local` scripts are gone (`pnpm check` and `pnpm dev` cover them); `pnpm test:coverage` is new. `PLAN.md` now holds only current status.
- **Library writes sent the wrong shape to `/me/library`.** Spotify takes the URIs as a query parameter and rejects a JSON body with 400. On this app the 400 tripped the regime fallback and the legacy route did the work, which is probably the "restricted rejects with 400" we recorded in July. On a restricted app the tools would have failed outright. Fixed for saves, removes, follows and unfollows, capped at Spotify's 40 URIs. Found by the Python sibling's 0.6.1.
- **Share links work everywhere.** `https://open.spotify.com/track/...` (and `intl-xx/` variants) are accepted wherever an ID or URI is, instead of being prefixed into nonsense. `check_library` now errors on a short answer rather than pairing booleans with the wrong IDs.
- **Shorter lookup names**, shared with the Python sibling: `get_tracks`, `get_artist`, `get_album` replace `get_track_details`, `get_artist_details`, `get_album_details`.
- **Playlist positions drifted after a missing track.** `get_playlist` dropped rows whose track was null (removed, region-locked or local files), so every position after one was off by one, and `reorder_playlist` and `remove_tracks_from_playlist` acted on the wrong rows. Those rows now stay in place as `Unavailable` with no `id`, and local files carry `is_local: true`. Ported from the Python sibling's 0.5.0 (spotify-mcp #16, #18, thanks [@tedeuxx](https://github.com/tedeuxx)). Its other 0.5.0 fixes do not apply here: search already pages at the restricted cap of 10, track details never batch, and `control_playback` never read state back.
- **The server icon never reached clients.** Two independent causes. `/favicon.ico` 301-redirected to an SVG, which favicon fetchers routinely skip; it now serves the PNG bytes directly. And `serverInfo.icons` used `data:` URIs, which the MCP spec explicitly lets consumers reject; they are now `https` URLs on the Worker. The origin is hardcoded, so forks should repoint `ORIGIN` in `src/index.ts`.

## 2026-07-30 — 0.4.0

### New tools (24 → 33)

- **Playlist cover art.** `set_playlist_cover` replaces a playlist's artwork. It takes an `https` URL rather than image data: Spotify wants base64-encoded JPEG in the request body, and 256 KB of that is roughly 340,000 characters, which is not something a model can emit as a tool argument. The Worker fetches the URL, rejects anything that isn't `image/jpeg`, encodes it and enforces the cap. This is the only non-JSON request body in the client, hence `RequestSpec.raw`.
- **Following.** `get_followed_artists`, `follow_artists`, `unfollow_artists`, and `follow_playlist` — which had been missing opposite `unfollow_playlist` since the beginning. `unfollow_playlist` also gained the `/me/library` fallback that the other library writes already had, so it survives a flip to the restricted regime.
- **Saved albums.** `get_saved_albums`, `save_albums`, `remove_saved_albums`. The library previously covered tracks only.
- **Artist discography.** `get_artist_albums`, filterable by `album` / `single` / `appears_on` / `compilation`. Spotify withdrew artist top-tracks from third-party apps, so this is the only way left to walk a catalog.
- Three new scopes come with these: `user-follow-read`, `user-follow-modify` and `ugc-image-upload`.

### A scope change could never take effect

- The Durable Object seeded its token state only when no token was stored, then refreshed that grant forever. Re-authorizing after a scope change did nothing useful: Spotify issued a correctly-scoped grant, the agent ignored it, and a refresh only ever returns the scopes the original token was minted with. Fixed by capturing Spotify's granted `scope` from the token response into the grant `props` and re-seeding whenever it differs from what's stored.
- A 403 whose reason mentions scope now says to reconnect and re-authorize, instead of the generic "the account may lack access" — that message is what made this take two rounds of live testing to spot.
- This is the second time a bug has lived exactly where the test suite substitutes a fake. Nothing exercises the Durable Object's token lifecycle.

### Housekeeping

- `package.json` said `0.2.0` while the MCP server reported `0.3.0` to clients. Both are now `0.4.0`, and `check:meta` fails if they ever drift again.
- Removed `savedTracksContain`, implemented but never registered as a tool.
- `PLAN.md` records the API surface we found and deliberately skipped — podcasts, audiobooks and chapters, the `contains` family, following users, reading playlist images — each with the reason, plus which of our tools are most likely to break if this app is ever moved to the restricted regime.

## 2026-07-27

### MCP protocol surface

- Every tool now carries behaviour annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and a human-readable `title`, so clients can tell a search from a deletion without guessing at tool names. `check:meta` fails a tool that ships without them.
- Server info gained `title`, `description`, `websiteUrl` and icons; `instructions` in the initialize result explains how the tools fit together and which Spotify capabilities are gone, so that guidance costs one payload instead of 24 tool descriptions.
- The icon is an equalizer mark generated by `pnpm make:icon` into `src/icon.ts` — SVG plus a hand-encoded PNG, no image dependencies, embedded as `data:` URIs and served at `/icon.svg` and `/icon.png`. It replaces a hotlinked copy of Spotify's own logo in the OAuth approval dialog.
- Three prompts (`discover_similar`, `taste_profile`, `build_playlist`) carry the workarounds for the withdrawn `/recommendations` and related-artists endpoints, which a model reading only the tool list would keep reaching for.

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
