# PLAN — spotify-mcp-cloudflare

Living status doc for the remote Spotify MCP server on Cloudflare Workers. The
deployed URL and setup are in `README.md`; history lives in `CHANGELOG.md` and
git. This file holds only what is current.

## Where things stand (2026-09-17)

34 tools and 3 prompts on a typed Spotify layer (`src/spotify.ts` client,
`src/endpoints.ts`, Zod shapes in `src/types.ts`), with per-family fallback
between the restricted (Feb 2026) and legacy API regimes. The tool surface is
`src/tools.ts`, driven in-process by `src/tools.test.ts`; `src/index.ts` is the
Durable Object, token lifecycle and OAuth wiring; `src/consent.ts` is the browser
consent flow. This app still gets the full/legacy regime on every family probed.

Lessons that keep paying: the offline suite can be green while production is
dead (2026-07-26, all 24 tools; 2026-07-30, scope re-grant), so changes to the
client, endpoints, scopes or auth get verified with live MCP calls. Green tests
are necessary, not sufficient. `/spotify-api-watch` is the reflex when a tool
starts failing in a way that smells upstream.

Kept in sync with the Python sibling
[spotify-mcp](https://github.com/jamiew/spotify-mcp): tool names, batch reads,
`check_library` and the 0.5.0 fixes came across in September 2026; nine tools
(cover art, follows, saved albums, discography) still only exist here.

## TODO

- [ ] Phase 6 — recommendations v2 ([#7](https://github.com/jamiew/spotify-mcp-cloudflare/issues/7), insight-driven since `/recommendations` is gone): `get_top_items` + `get_recently_played` landed as the measured foundation; the `discover_similar` prompt is the stopgap; `recommend_tracks` still to design
- [ ] Optional: elicitation gating for destructive ops (unfollow_playlist, remove_*) — partly moot now that those tools declare `destructiveHint`, which is what clients gate on; only worth it for clients that ignore annotations
- [ ] Optional: publish to the MCP registry ([#5](https://github.com/jamiew/spotify-mcp-cloudflare/issues/5)) — the last real discoverability gap
- [ ] Live smoke test in CI ([#4](https://github.com/jamiew/spotify-mcp-cloudflare/issues/4)) — point `scripts/e2e.ts` at the deployed Worker and run it on a schedule; the fake-upstream suite structurally cannot catch the bug class found on 2026-07-26
- [ ] Verify `add_to_queue` / `control_playback` / `transfer_playback` against a real active device ([#6](https://github.com/jamiew/spotify-mcp-cloudflare/issues/6))
- [ ] Don't retry 429s carrying `QUOTA_EXCEEDED` ([#2](https://github.com/jamiew/spotify-mcp-cloudflare/issues/2)) — quota is counted per developer account since July 2026, so retries burn every app's pool
- [ ] Accept `account_id` in the allowlist ([#3](https://github.com/jamiew/spotify-mcp-cloudflare/issues/3))
- [ ] Use `127.0.0.1`, not `localhost`, in the local redirect-URI docs ([#8](https://github.com/jamiew/spotify-mcp-cloudflare/issues/8))
- [ ] Public multi-user hosting is capped by Spotify at 5 users/app ([#1](https://github.com/jamiew/spotify-mcp-cloudflare/issues/1)) — recorded as a constraint, not a task; self-hosting is the answer
- [ ] Move from the deprecated `McpAgent` to `createMcpHandler` with MCP SDK v2 (agents 0.20+); drops the v1 SDK from the bundle and the 800 KiB size budget back to 600
- [ ] Request logging (one line per Spotify request and per tool call) so Workers Logs can show what real traffic looks like before optimizing further
- [ ] Optional: `control_playback` could read state back after acting, as the Python server does (bounded polling, since Spotify's player writes are asynchronous)

## Known API surface we haven't implemented

Audited 2026-07-30 against the live Web API reference and the February 2026
migration guide. These are alive and reachable — the reasons are ours, not
Spotify's. Anything Spotify has withdrawn (`/recommendations`, audio-features,
audio-analysis, related-artists) is dead upstream and belongs in Phase 6, not here.

- **Podcasts, audiobooks, chapters** — shows/episodes/audiobooks lookups, the
  saved-episodes and saved-shows library, and `user-read-playback-position` for
  resume points. The largest single gap by endpoint count. Deliberately skipped:
  jamiew doesn't use Spotify for spoken word, and it would roughly double the
  tool surface (`search_music` would need two more types, and the library tools
  a third and fourth kind). Revisit only on a concrete need.
- **`GET /me/following/contains` and the saved-`contains` family** — "is this
  already saved/followed?" for tracks, albums, artists, playlists. We had a
  `savedTracksContain` implementation for this and deleted it unused; the model
  can answer the question from `get_saved_tracks` / `get_followed_artists`
  without a dedicated tool. Worth adding only if we hit cases where it can't.
- **Follow/unfollow *users*** (`type=user` on the same endpoints as artists) —
  trivial to add on top of what just landed, but there's no workflow asking for it.
- **`GET /playlists/{id}/images`** — reading a playlist's cover URL. Cheap, and
  the natural counterpart to `set_playlist_cover`; skipped because nothing
  currently consumes image URLs. Reconsider if we ever render playlists visually.
- **Cursor pagination on `GET /me/following`** — it pages by `after`, not
  `offset`, so `get_followed_artists` exposes `limit` only and tops out at 50.
  Fine until someone follows more artists than that and wants the tail.

Restricted-regime landmines, tracked here so they aren't rediscovered: Spotify
removed `GET /artists/{id}/top-tracks`, all batch fetches (`GET /tracks`,
`/albums`, `/artists`), `GET /browse/*`, and `GET /users/{id}` in the restricted
regime. `get_tracks` tries the batch route and falls back to single fetches on 403, and
saved *albums* is documented as Extended-Quota-only under restricted mode — so
`get_saved_albums` / `save_albums` / `remove_saved_albums` are the tools most
likely to disappear if this app ever flips.
