# spotify-mcp-cloudflare

**Beta.** The canonical TypeScript implementation for local stdio and remote MCP on [Cloudflare Workers](https://developers.cloudflare.com/workers/), sharing one typed Spotify client and tool surface. The [Python classic edition](https://github.com/jamiew/spotify-mcp) remains supported, not deprecated. New tool/API work starts here; fixes worth sharing are ported back without pretending the two public contracts are identical.

The remote auth layer originated in [lassejlv/spotify-mcp](https://github.com/lassejlv/spotify-mcp) (MIT; upstream unavailable during the September 2026 research refresh). The compact tool/API design was informed by [markandeyay/spotify-mcp](https://github.com/markandeyay/spotify-mcp). Keep attribution separate from permission: review a project's license before copying additional code.

## Live instance

Deployed at **`https://spotify-mcp-cloudflare.jamie-7e9.workers.dev/mcp`** (Streamable HTTP; legacy SSE at `/sse`). This instance is intended for invitations, not a public Spotify service. Its deployed revision can lag this branch. Spotify normally allows five dashboard-allowlisted users per Development Mode app; see [sharing and policy](#sharing-and-policy) before inviting users or self-hosting.

Remote auth is handled over the web: the server is an OAuth provider to the MCP
client and performs a separate Spotify OAuth flow upstream. Each user authorizes
their own account. The shared Spotify client adapts between restricted and
legacy endpoint shapes per family; API availability still depends on the app's
access and the user's permissions.

## Architecture

- A shared server factory registers the same 34 tools and three prompts for both
  launch modes. The endpoint layer depends on a token provider, not a transport.
- Local stdio uses a private filesystem token store and explicit PKCE login.
  It does not require a Cloudflare deployment or a Spotify client secret.
- **`McpAgent`** (`SpotifyMCP`, a Durable Object) hosts the MCP server and tools,
  served over Streamable HTTP at `/mcp` (and legacy SSE at `/sse`).
- **`@cloudflare/workers-oauth-provider`** wraps the Worker. It issues tokens to
  MCP clients and stores the upstream Spotify tokens (access + refresh) encrypted
  in the grant `props`.
- **`SpotifyHandler`** (Hono app) implements `/authorize` and `/callback`, driving
  the Spotify authorization-code flow and showing the consent dialog.
- The agent persists a working access token in its Durable Object state and
  **refreshes it automatically** using the stored refresh token. It also records
  the scopes that token was granted, and re-seeds from a fresh grant when they
  change — refreshing alone can only ever return the original scopes, so without
  that a newly requested scope could never take effect.

```text
MCP client ──/mcp──▶ OAuthProvider ──▶ SpotifyMCP (Durable Object)
     │                    │                     │
   /authorize        /callback            Spotify Web API
     └────── Spotify consent (browser) ────────┘
```

## Tools

34 tools. Tracks and playlists accept bare IDs or full `spotify:` URIs everywhere.

| Area | Tools |
| --- | --- |
| Profile | `get_me` |
| Search & lookups | `search_music` (per-type, paginated), `get_tracks` (batch of up to 50), `get_artist` (batch of up to 50), `get_artist_albums` (discography, filterable by release type), `get_album` (batch of up to 20, with track lists) |
| Playlists | `list_playlists`, `get_playlist` (details + positioned tracks), `create_playlist`, `update_playlist_details`, `set_playlist_cover`, `add_tracks_to_playlist`, `remove_tracks_from_playlist`, `reorder_playlist`, `follow_playlist`, `unfollow_playlist` |
| Library | `get_saved_tracks`, `save_tracks`, `remove_saved_tracks`, `get_saved_albums`, `save_albums`, `remove_saved_albums`, `check_library` (are these saved or followed?) |
| Following | `get_followed_artists`, `follow_artists`, `unfollow_artists` |
| Playback | `get_playback_state`, `control_playback` (play/pause/next/previous/seek/volume/shuffle/repeat), `get_queue`, `add_to_queue`, `list_devices`, `transfer_playback` |
| Listening history | `get_recently_played`, `get_top_items` (top artists/tracks by time range) |

Tools publish output schemas and return compact objects, not raw Spotify JSON.
Successful mutations include structured acknowledgements and readable text.
Errors identify reauthorization, Premium/device requirements and rate limits.

Every tool carries read/write, destructive and idempotency annotations. These
are client hints, **not authorization or proof of human approval**. Playlist
removal requests form elicitation when the client supports it; decline, cancel
or elicitation failure prevents the removal. Clients without elicitation retain
the normal tool-call flow, so use the client's own write-confirmation controls.

## Prompts

Three prompts ship as client templates. They compose available tools; they do
not restore restricted Spotify recommendation APIs or establish permission to
send Spotify content to an AI model. Review [sharing and policy](#sharing-and-policy).

| Prompt | Args | What it does |
| --- | --- | --- |
| `discover_similar` | `artist` | Explores available artist metadata and search without claiming related-artist equivalence |
| `taste_profile` | `time_range` | Summarizes available listening history with policy and inference limits |
| `build_playlist` | `vibe`, `size` | Drafts a tracklist from your history, confirms, then creates it |

## Discovery metadata

What a client learns about this server before it calls anything:

- **`instructions`** in the initialize result explain tool relationships,
  app-dependent API availability, zero-based positions and Premium playback.
- **Icons** on the server info as `https` URLs on the Worker (the spec lets
  clients reject `data:` URIs). The shared server metadata uses the author's
  Worker origin; forks should repoint it. Icons are also served at `/icon.svg`,
  `/icon.png` and `/favicon.ico`.
- **`title`, `description`, `websiteUrl`** on the server info, and a `title` on
  every tool, for clients that render a human-readable surface.
- **OAuth discovery** at `/.well-known/oauth-authorization-server`, plus dynamic
  client registration at `/register`, so no client needs manual config.

The icon is generated, not hand-drawn — `pnpm make:icon` re-renders
`src/icon.ts` (SVG plus a hand-encoded PNG, no image dependencies) from the
shapes at the top of `scripts/make-icon.ts`.

## Deploy it yourself

Runs on the Cloudflare Workers free tier.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up); you'll log in with
  `pnpm wrangler login` once dependencies are installed.
- A [Spotify Developer](https://developer.spotify.com/dashboard) account.
- Node.js 22.18+ and [pnpm](https://pnpm.io), using the version pinned in
  `package.json`. Wrangler and the local TypeScript runner are project
  dependencies, not global installs.

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
pnpm wrangler kv namespace create OAUTH_KV
```

Copy the returned `id` into `wrangler.jsonc`, replacing the existing `OAUTH_KV`
`id` value (the checked-in one belongs to the original author's account and won't
work for you).

### 3. Set secrets

```sh
pnpm wrangler secret put SPOTIFY_CLIENT_ID       # your Spotify Client ID
pnpm wrangler secret put SPOTIFY_CLIENT_SECRET   # your Spotify Client Secret
pnpm wrangler secret put COOKIE_ENCRYPTION_KEY   # any random string, e.g. `openssl rand -hex 32`
```

For friends-only access, configure a nonempty allowlist:

```sh
# Entries can be stable Spotify user/account IDs or emails.
# Empty or unset means any upstream-authorized account may connect.
pnpm wrangler secret put ALLOWED_EMAILS          # e.g. me@example.com,spotify_user_id,account_id
```

Prefer stable user/account IDs because some apps cannot read account email.
The Worker allowlist is independent of Spotify's dashboard user allowlist.
Do not treat possession of the URL as access control.

### 4. Deploy

```sh
pnpm run deploy
```

Your server is now live at `https://spotify-mcp-cloudflare.<your-subdomain>.workers.dev/mcp`.

## Connect an MCP client

The checked-in `.mcp.json` points at the author's restricted instance. Forks
should replace that URL with their own deployment.

Point an OAuth-capable remote MCP client at `/mcp`. For local-only clients, use
the native stdio mode below. If you intentionally want hosted dependence,
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) can bridge HTTP to stdio:

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

## Native local stdio

Requires macOS or Linux, Node.js 22.18+ and `pnpm install`. Register this exact additional redirect
URI in your Spotify app: **`http://127.0.0.1:8888/callback`**.

```sh
export SPOTIFY_CLIENT_ID=your_client_id
pnpm login
# Open the authorization URL printed to stderr and approve in your browser.
pnpm --silent stdio
```

Login is explicit; starting the MCP server never launches a browser or writes
auth messages to stdout. PKCE uses a random state and an S256 challenge, with a
loopback-only callback and timeout. No client secret is needed for local mode.

For an MCP client that launches subprocesses:

```json
{
  "mcpServers": {
    "spotify": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/spotify-mcp-cloudflare", "--silent", "stdio"],
      "env": { "SPOTIFY_CLIENT_ID": "your_client_id" }
    }
  }
}
```

The token directory defaults to `~/.local/state/spotify-mcp`; set
`SPOTIFY_MCP_STATE_DIR` to an absolute path to isolate another local account.
Tokens are plaintext credentials protected by private directory/file permissions,
not encrypted at rest by this application. Writes are atomic and rotated refresh
tokens persist. One process owns a token directory at a time; disconnect the MCP
client before running `pnpm login` again or `pnpm signout`.

`pnpm signout` removes local tokens; revoke the application in Spotify's account
settings to withdraw upstream access too. A crashed process may leave `owner.lock`:
confirm its owning process is gone before manually removing that lock directory.
Do not share token directories or expose a local stdio process as a multi-user
HTTP service.

### Python migration boundaries

The Python edition remains supported. Both use the same API compatibility
direction, but Python has separate playlist/membership tools, resources, five
prompts and best-effort playback confirmation. This implementation has 34 tools,
three prompts, no resources and acknowledgement-only playback writes.
Migrate client arguments/results explicitly; do not uninstall Python based on
matching package versions. Local TypeScript mode removes the need for a second
tool implementation, not the need to preserve workflows.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then fill in the three values
pnpm dev
```

`wrangler dev` simulates KV locally. Use `http://127.0.0.1:8788/callback` (Spotify
rejects `localhost`) as an
additional Spotify redirect URI for local testing.

## Notes

- Tracks and playlists can be referenced by bare ID or full `spotify:` URI in any tool.
- `reorder_playlist` uses zero-based positions; call `get_playlist` first to see current positions.
  Unavailable and local tracks keep their position with no `id`, so the numbers line up with Spotify's.
  Pass the returned `snapshot_id` to `reorder_playlist` to guard against intervening edits.
- `get_playlist` returns one page by default. Set `fetch_all: true` for bounded
  pagination with progress notifications when the client supplies a progress token.
  `max_items` defaults to 1,000 and permits at most 10,000. Check `contents_status`,
  `complete`, `truncated` and `next_offset`; denied or partial contents are not an
  empty playlist.
- `search_music.offset` applies to each requested result type, between 0 and
  1,000. Its `limit` is a total per type, not a page size.
- Playback control endpoints require Spotify Premium and an active device.
- `set_playlist_cover` takes an `https` URL rather than image data: Spotify wants
  base64-encoded JPEG in the request body, which is far too large to pass as a
  tool argument, so the Worker fetches and encodes it. Both limits — JPEG only,
  and Spotify's 256 KB cap on the encoded payload — are enforced in the Worker
  before anything is sent, so those errors never appear in Spotify's logs.
- Requested scopes: playlist read/modify (public + private), library read/modify,
  follow read/modify, `ugc-image-upload` (playlist cover art), playback
  read/modify, `user-top-read`, `user-read-recently-played`, `user-read-private`,
  and `user-read-email` (used for the `ALLOWED_EMAILS` access gate). Adding a
  scope does not upgrade an existing token — reconnect the server via `/mcp`
  after one changes. Not requested, and so not implemented:
  `user-read-playback-position` (podcast/audiobook resume).
- Access control: set the `ALLOWED_EMAILS` secret to a comma-separated list of
  emails, user ids and/or account ids to restrict the server. An unset allowlist
  allows anyone through this gate, so keep it nonempty on a shared deployment.
  Existing sessions are checked again before tool use.
- Recommendations, audio features and related artists are not exposed here.
  Spotify restricted access for new/development integrations; approved older
  integrations may differ. Search relevance is not an official artist top-track ranking.

## Sharing and policy

Sharing source, inviting friends to a hosted app, and running unrestricted public
enrollment are different decisions. Keep your client secret on the Worker; each
friend completes their own Spotify OAuth. Never share your access/refresh token.

Before inviting friends:

1. Confirm the developer app's eligibility, Premium owner subscription, exact
   HTTPS `/callback` URI and dashboard allowlist.
2. Configure nonempty `ALLOWED_EMAILS`, preferably with stable IDs.
3. Explain the requested read/write/playback scopes. There is no enforced
   read-only MCP permission tier.
4. Verify two-account isolation, expiry, concurrent refresh, reconnect and
   removal against the deployed revision.
5. Provide a privacy notice and a real disconnect/data-deletion procedure.
   Deleting a connector or changing an allowlist is not complete upstream-token
   and Durable Object cleanup.

[Spotify's quota rules](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
normally cap Development Mode at **five users per app**. Existing larger
allowlists are grandfathered, not permission to add unlimited users. Extended
quota applications currently require an organization, an active launched service
and at least **250,000 monthly active users**, among other criteria. Self-hosting
does not waive these requirements or the developer policies.

**AI use needs separate policy clearance.** The
[Developer Policy](https://developer.spotify.com/policy), III.14, prohibits
training **or otherwise ingesting Spotify Content into an AI/ML model**.
III.13 restricts analysis/derived metrics and III.3 restricts voice assistants.
“No training” or “metadata only” is not automatic permission for an MCP service.
Spotify's own ChatGPT integration and community servers do not establish that
permission. Resolve the intended data flow with Spotify before advertising
public access. This is a policy warning, not legal advice.

The current remote implementation is not certified for unrestricted hosting.
Before that, review canonical OAuth resource/audience binding, per-user/IP abuse
limits, grant/session revocation, privacy-safe logs and one authoritative token
owner per grant. OAuth grant props encryption does not imply that the additional
tokens in Durable Object state receive the same application-level encryption.
The [current MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
prefers Client ID Metadata Documents; this server retains DCR for compatibility.
CIMD requires safe metadata fetching, not just enabling a flag.

## Official API updates reviewed September 2026

- [July 23 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates):
  up to **25 Client IDs**, but Development Mode apps share quota **per developer
  account**. A 429 with `QUOTA_EXCEEDED` is surfaced without retries. Spotify does
  not promise a universal 24-hour reset here. Ordinary short `Retry-After` values
  are honored; longer waits are returned to the caller without an early retry.
- [February announcement, March 9 update](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security):
  endpoint restrictions for existing integrations were **postponed**. The old
  migration-guide timeline should not be read as proof every old app was switched.
  Extended Quota Mode is exempt from those endpoint changes.
- [Restricted-mode migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide):
  `/me/playlists`, playlist `/items`, generic `/me/library` URI queries, search
  pages of at most 10 and individual metadata lookups replace older shapes.
  Playlist contents require ownership/collaboration in this regime; a missing
  contents field is not proof the playlist is empty.
- [March reversal](https://developer.spotify.com/documentation/web-api/references/changes/march-2026):
  album/track `external_ids` remain available.
- [Official TypeScript SDK](https://github.com/spotify/spotify-web-api-ts-sdk):
  the latest published version checked was **1.2.0**; its playlist methods still
  use legacy routes. Keep the compatibility-aware fetch layer rather than
  switching merely for the official label.
- [Spotify in ChatGPT](https://newsroom.spotify.com/2025-10-06/spotify-personalized-prompts-chatgpt/)
  is an official consumer integration, not a documented reusable public MCP
  endpoint. No such official endpoint/package was found in the research.

Ideas worth borrowing selectively: [iceener](https://github.com/iceener/spotify-streamable-mcp-server)
for HTTP/token boundaries, [leoalord](https://github.com/leoalord/spotify-mcp-server)
for per-subject credentials, and [Stipe15](https://github.com/Stipe15/spotify-mcp)
for argument-bound write previews. [JamRelay](https://github.com/makkiattooo/JamRelay)
has explicit provider/connection targeting, but a different Node/SQLite deployment
and AGPL license. None is a drop-in replacement or evidence of Spotify policy approval.

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

Newly restricted and older/extended apps may return different shapes.
`src/spotify.ts` caches successful fallback choices per family. Do not infer the
app's regime from the date or classify every authorization failure as retirement.

## Skills

This repo ships agent skills that keep it current without anyone remembering to
check. If you run Claude Code here, they're worth trying.

### `/spotify-api-watch`

Answers two questions: **what did Spotify change**, and **does this server still
work**. It sweeps the changelog (`pnpm api:watch`), classifies each new item as
breaking / unlocking / irrelevant against the actual code, then runs a live
conformance probe to detect a silent regime flip — because a clean changelog
doesn't mean nothing broke.

Run it before a release, when a tool starts failing in a way that smells
upstream, or on a schedule. It found four unreviewed changelog entries the first
time it ran, including one that makes our account allowlist key on a field
Spotify now steers away from.

To run it weekly and get alerted rather than auto-changed, schedule the sweep and
let its nonzero exit drive the notification. Don't automate `--accept` — that
marks entries reviewed with nobody reading them.

### Agent instructions

`CLAUDE.md` carries the working rules for agents, most importantly: **this
repo's test suite can pass while production is entirely broken.** All 42 tests
were green on 2026-07-26 while every one of the 24 tools was dead, because the
bugs sat exactly where the suite substitutes a fake. It happened again on
2026-07-30: a green suite and a clean deploy, but re-authorizing couldn't
actually upgrade the granted scopes, because nothing tests the Durable Object's
token lifecycle. Changes to the Spotify client, endpoints, scopes or auth get
verified with live MCP calls, not just `pnpm test`. Worth reading before your
first change here even if you're human.

## Development

`pnpm check` runs the repository quality gates; it is not a live Spotify verification:

```sh
pnpm check       # lint + markdownlint + typecheck + meta-lint + tests + size budget + security
pnpm test        # just the tests (vitest in workerd via @cloudflare/vitest-pool-workers)
pnpm check:meta  # code<->README tool parity, version parity, description budgets
pnpm check:size  # worker bundle vs 800 KiB gzip budget
pnpm check:sec   # gitleaks secret scan + dependency audit (brew install gitleaks)
pnpm e2e         # live OAuth smoke test against the deployed worker
pnpm api:watch   # check for unreviewed Spotify Web API changelog entries
```

Tests run fully offline against a fake Spotify upstream (`src/fake-spotify.ts`),
including integration tests of the real worker (OAuth discovery, DCR, 401 gating,
approval dialog).
