# PLAN — spotify-mcp-cloudflare

Living status for the canonical TypeScript Spotify implementation. Setup and
upstream policy citations are in `README.md`; history is in `CHANGELOG.md`.
Source changes on a branch are not evidence that the hosted instance is updated.

## Direction (2026-09-20)

One Spotify API/tool core, two transports: local stdio with explicit PKCE login,
and the existing OAuth-protected Cloudflare Worker. Start new tool and API work
here. The [Python classic edition](https://github.com/jamiew/spotify-mcp) remains
supported, with selected compatibility fixes ported back. Do not remove it just
because both projects have the same version number.

The canonical surface has 44 tools and three prompts. It matches the Python
edition's podcast, episode and audiobook library tools (membership checks fold
into `check_library`) and describes episodes in playback, queue and playlist
reads. Python still has resources, two additional prompts and best-effort
playback confirmation.
Public names and result shapes differ; this is not a drop-in client migration.

The Worker is stateless on MCP SDK v2 (`createMcpHandler`) and serves both the
2026-07-28 revision and 2025-era clients. The OAuth grant is the single owner of
each user's Spotify tokens: `tokenExchangeCallback` renews Spotify on MCP refresh
and writes the result back. Local mode must not import Cloudflare-only modules or
share one person's tokens with other users.

## Completed API corrections

- `QUOTA_EXCEEDED` is surfaced without retry. Development Mode quota is shared
  across the developer account. No universal reset time is promised.
- Ordinary rate limits are retried only when the full `Retry-After` fits the
  bounded wait; longer waits are returned to the caller without retrying early.
- Account allowlists accept email, user ID and immutable account ID. Prefer IDs.
- Redirect documentation uses `127.0.0.1`, not `localhost`.
- Local login instructions explicitly run `pnpm run login`, not pnpm's registry login.
- Invalid OAuth clients and redirects fail locally without redirecting. Other
  authorization validation errors redirect only after provider validation.
- E2e cached registrations with a mismatched callback require fresh registration
  and consent after an exclusive, private backup; old tokens are not reused.
- Generic library routes use URI query parameters; `check_library` is implemented.
- Optional restricted-response fields and missing/local playlist positions remain
  intact. The February endpoint rollout for older integrations was postponed;
  date alone does not establish an app's regime.

## Verification and release gates

Offline tests once passed while every production tool failed. Run `pnpm check`,
then exercise the actual local process and remote workerd surface. Mocked upstream
requests establish request shapes and failure behavior, not Spotify acceptance.
Before deploying auth/client/scope changes, verify authenticated live reads,
refresh and reauthorization. Scope changes require new consent; never delete a
user's cache automatically to force it.

A branch push opens CI but does not deploy: deployment is gated on `main` and
`DEPLOY_ENABLED`. Do not publish, merge or deploy as part of a code-only update.

On the SDK v2 branch, `pnpm check` passes 175 workerd tests (tool surface on three
protocol lanes, plus real grants, refresh, rotation, revocation and stale-token
401s) and seven Node auth tests, with a 307.6 KiB gzip bundle. The actual stdio
process serves 44 tools and three prompts on both eras with synthetic tokens, and
asks for and honors a declined removal on each. `wrangler dev` serves the `/mcp`
resource metadata and 404s `/sse`. Not yet run: `pnpm e2e` against a deployment
of this branch, which needs Spotify consent in a browser.

Fresh native PKCE consent, real upstream refresh, private token persistence and
all 17 read tools pass through the actual stdio entrypoint. All 14 non-playback
write tools pass with disposable playlists and restored library membership.
Python passes its 17 read tools, eight non-playback writes, six resources and five prompts.
The deployed 0.7.0 Worker passes all 17 read tools and 14 non-playback write tools,
including confirmed removal and cover upload. Temporary playlists were unfollowed
and original library membership restored. Mismatched OAuth redirects return 400
without a redirect. Native 0.7.0 also passes all 17 read tools.
Playback and queue writes remain intentionally untested without explicit permission.

## Remaining decisions

- Before deploying SDK v2, count live grant resources (command in the
  `workers-oauth-provider` migration guide). Grants bound to `/sse` or the bare
  origin sign in once; `/mcp` grants keep working. Then run `pnpm e2e` and check
  a refresh on an existing session.
- Evaluate CIMD: it needs the `global_fetch_strictly_public` compatibility flag
  and `clientIdMetadataDocumentEnabled`. Keep DCR for current clients.
- 2025-era remote clients can't be asked to confirm removal over stateless HTTP.
  A sessionful legacy lane would fix that at the cost of the Durable Object; only
  worth it if users rely on it before their clients move to 2026-07-28.
- Provide remote disconnect/data deletion and explicit grant/session revocation.
  An allowlist edit is not complete data cleanup.
- Add per-user/IP auth and tool abuse controls plus an app/developer quota budget
  before expanding enrollment. Check Cloudflare-side controls, not source alone.
- Confirm public MCP/AI use with Spotify. Its AI-input and analysis policy applies
  beyond model training. Five-user Development Mode and organization-only extended
  access criteria remain independent constraints, not bugs that code can remove.
- Reconsider the existing recommendation issue only after policy clearance. Search
  results are not Spotify's artist top-track ranking; model-generated suggestions
  are not an official replacement for restricted recommendation APIs.
- Port resources, additional prompts or playback confirmation if actual users need
  them before retiring Python. Keep one canonical tool core rather than adding a
  second implementation inside this repository.
- Verify playback writes against an active device only with explicit permission;
  do not play, pause or edit playlists during an unattended read-only smoke run.

## Deliberately excluded surface

Audiobook chapters remain out of scope without a concrete workflow. Following
users, playlist-image reads and followed-artist cursor pagination are separate
needs, not automatic additions for endpoint parity.
No new insight/analytics service or mixed Spotify/SoundCloud player is being built.
Borrow SoundCloud's local/remote architecture, not its content or credentials.
