# spotify-mcp-cloudflare

**Beta.** Followup to my python [spotify-mcp](https://github.com/jamiew/spotify-mcp), rewritten in TypeScript as a **remote** MCP server on [Cloudflare Workers](https://developers.cloudflare.com/workers/) -- auth layer forked from [lassejlv/spotify-mcp](https://github.com/lassejlv/spotify-mcp) (MIT), tool design and typed-endpoint approach borrowed from [markandeyay/spotify-mcp](https://github.com/markandeyay/spotify-mcp). Goal: all the major Spotify API functions as well-designed, token-efficient tools, with a recommendations layer on top (in progress -- Spotify killed `/recommendations` for third-party apps, so we're rebuilding from top-items + recently-played instead).

## Live instance

Deployed at **`https://spotify-mcp-cloudflare.jamie-7e9.workers.dev/mcp`** (Streamable HTTP; legacy SSE at `/sse`). The Spotify API key behind it is registered to MCP author [@jamiew](https://github.com/jamiew) -- Spotify Development Mode caps any app at ~5 dashboard-allowlisted users, so if you want in, deploy your own (below) or open an issue.

Auth is handled entirely over the web: the server is its own OAuth provider to
the MCP client, and performs the Spotify OAuth flow upstream. There is no local
binary and no `authenticate` tool -- connecting the server in your MCP client
opens the Spotify consent screen in your browser. The Spotify client
transparently falls back between the restricted (Feb 2026) and legacy API
shapes per endpoint family, so it works with both old and new Spotify apps.

## Architecture

- **`McpAgent`** (`SpotifyMCP`, a Durable Object) hosts the MCP server and tools,
  served over Streamable HTTP at `/mcp` (and legacy SSE at `/sse`).
- **`@cloudflare/workers-oauth-provider`** wraps the Worker. It issues tokens to
  MCP clients and stores the upstream Spotify tokens (access + refresh) encrypted
  in the grant `props`.
- **`SpotifyHandler`** (Hono app) implements `/authorize` and `/callback`, driving
  the Spotify authorization-code flow and showing the consent dialog.
- The agent persists a working access token in its Durable Object state and
  **refreshes it automatically** using the stored refresh token.

```text
MCP client ──/mcp──▶ OAuthProvider ──▶ SpotifyMCP (Durable Object)
     │                    │                     │
   /authorize        /callback            Spotify Web API
     └────── Spotify consent (browser) ────────┘
```

## Tools

24 tools. Tracks and playlists accept bare IDs or full `spotify:` URIs everywhere.

| Area | Tools |
| --- | --- |
| Profile | `get_me` |
| Search & lookups | `search_music` (per-type, paginated), `get_track_details` (batch), `get_artist_details`, `get_album_details` |
| Playlists | `list_playlists`, `get_playlist` (details + positioned tracks), `create_playlist`, `update_playlist_details`, `add_tracks_to_playlist`, `remove_tracks_from_playlist`, `reorder_playlist`, `unfollow_playlist` |
| Library | `get_saved_tracks`, `save_tracks`, `remove_saved_tracks` |
| Playback | `get_playback_state`, `control_playback` (play/pause/next/previous/seek/volume/shuffle/repeat), `get_queue`, `add_to_queue`, `list_devices`, `transfer_playback` |
| Listening history | `get_recently_played`, `get_top_items` (top artists/tracks by time range) |

All responses are compact, reshaped objects (never raw Spotify JSON), returned as
both text and `structuredContent`. Errors come back as short actionable sentences
(re-auth needed, Premium required, no active device, rate limited).

## Deploy it yourself

Runs on the Cloudflare Workers free tier.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) and the Wrangler CLI logged in (`npx wrangler login`).
- A [Spotify Developer](https://developer.spotify.com/dashboard) account.
- Node.js 18+.

### 0. Get the code

```sh
pnpm install
```

### 1. Create a Spotify app

At <https://developer.spotify.com/dashboard>, create an app and note the
**Client ID** and **Client Secret**. Under **Redirect URIs**, add your Worker's
callback URL:

```text
https://spotify-mcp-cloudflare.<your-subdomain>.workers.dev/callback
```

(The workers.dev subdomain is shown after the first `wrangler deploy`. Add the
URI, then deploy again if needed. A custom domain's `/callback` works too.)

### 2. Create the KV namespace

The OAuth provider stores grants, tokens and clients in KV.

```sh
npx wrangler kv namespace create OAUTH_KV
```

Copy the returned `id` into `wrangler.jsonc`, replacing the existing `OAUTH_KV`
`id` value (the checked-in one belongs to the original author's account and won't
work for you).

### 3. Set secrets

```sh
npx wrangler secret put SPOTIFY_CLIENT_ID       # your Spotify Client ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET   # your Spotify Client Secret
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # any random string, e.g. `openssl rand -hex 32`
```

Optional — restrict who can use the server:

```sh
# Comma-separated allowlist of Spotify account emails. Only these accounts can
# authorize; everyone else is rejected at the callback (no token issued).
# Leave unset to allow any Spotify account.
npx wrangler secret put ALLOWED_EMAILS          # e.g. me@example.com,spotify_user_id
```

Entries match the Spotify account email **or** user id — newer Spotify apps no
longer expose the email, so ids keep the allowlist usable there. Note Spotify
Development Mode separately caps apps at ~5 dashboard-allowlisted users.

### 4. Deploy

```sh
npx wrangler deploy
```

Your server is now live at `https://spotify-mcp-cloudflare.<your-subdomain>.workers.dev/mcp`.

## Connect an MCP client

Point any remote-MCP-capable client at the `/mcp` URL. Clients that only speak
stdio can bridge via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": ["mcp-remote", "https://spotify-mcp-cloudflare.<your-subdomain>.workers.dev/mcp"]
    }
  }
}
```

On first connect, your browser opens: approve the MCP client, then log in and
grant Spotify access. Tokens are refreshed automatically thereafter.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then fill in the three values
npx wrangler dev
```

`wrangler dev` simulates KV locally. Use `http://localhost:8788/callback` as an
additional Spotify redirect URI for local testing.

## Notes

- Tracks and playlists can be referenced by bare ID or full `spotify:` URI in any tool.
- `reorder_playlist` uses zero-based positions; call `get_playlist` first to see current positions.
- Playback control endpoints require Spotify Premium and an active device.
- Requested scopes: playlist read/modify (public + private), library read/modify,
  playback read/modify, `user-top-read`, `user-read-recently-played`,
  `user-read-private`, and `user-read-email` (used for the `ALLOWED_EMAILS`
  access gate). Not requested, and so not implemented: `user-follow-read` /
  `user-follow-modify` (follow artists), `ugc-image-upload` (playlist cover art),
  `user-read-playback-position` (podcast/audiobook resume).
- Access control: set the `ALLOWED_EMAILS` secret to a comma-separated list of
  emails and/or user ids to restrict the server; leave it unset to allow anyone.
- `/recommendations`, audio-features and related-artists are dead for third-party
  apps; `get_top_items` + `get_recently_played` are the measured foundation for
  building recommendations instead.

## Tracking Spotify API changes

Spotify ships breaking changes to the Web API with little notice, and publishes
**no RSS feed and no changelog index**. Entries live at predictable per-month
URLs that 404 until they exist, so the only reliable way to notice one is to
probe the month space:

```sh
pnpm api:watch            # exits 1 if there are unreviewed changelog entries
pnpm api:watch --accept   # record them as reviewed (only after actually reading them)
```

Reviewed entries are recorded in `scripts/spotify-api-seen.json`. The
`spotify-api-watch` skill wraps this with impact analysis and a live conformance
probe — run it before a release, or on a schedule to get alerted.

Where changes surface, in the order they usually appear:

| Source | Notes |
| --- | --- |
| [Developer community forum](https://community.spotify.com/t5/Spotify-for-Developers/bd-p/Spotify_Developer) | Undocumented breakage shows up here first, often days early |
| Changelog `.../references/changes/<month>-<year>` | Authoritative but after the fact; no index page |
| [Feb 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) | The regime split this server's fallback logic exists for |
| [Official TS SDK](https://github.com/spotify/spotify-web-api-ts-sdk) issues | We don't depend on it, but its bug reports are an early signal |

The Feb 2026 changes split apps into a **full/legacy** and a **restricted**
regime with different endpoint shapes. `src/spotify.ts` falls back between them
per endpoint family and caches the answer, so both work — see `withFallback`.

## Development

`pnpm check` runs everything CI runs, so a green local check means a green build:

```sh
pnpm check       # lint + markdownlint + typecheck + meta-lint + tests + size budget + security
pnpm test        # just the tests (vitest in workerd via @cloudflare/vitest-pool-workers)
pnpm check:meta  # code<->README tool parity + tool-description token budgets
pnpm check:size  # worker bundle vs 600 KiB gzip budget
pnpm check:sec   # gitleaks secret scan + dependency audit (brew install gitleaks)
pnpm e2e         # live OAuth smoke test against the deployed worker
pnpm api:watch   # check for unreviewed Spotify Web API changelog entries
```

Tests run fully offline against a fake Spotify upstream (`src/fake-spotify.ts`),
including integration tests of the real worker (OAuth discovery, DCR, 401 gating,
approval dialog).
