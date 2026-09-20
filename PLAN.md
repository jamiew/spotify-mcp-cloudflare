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

The canonical surface keeps 34 tools and three prompts. This update brings over
output schemas, explicit search offset, snapshot-guarded reordering, bounded
playlist pagination/progress and client-supported removal elicitation. Python
still has resources, two additional prompts and best-effort playback confirmation.
Public names and result shapes differ; this is not a drop-in client migration.

The Worker remains on McpAgent and MCP SDK v1 for this pass. Changing the token
owner, transport and SDK at the same time as adding local mode would make failures
harder to isolate. Local mode must not import Cloudflare-only modules or share
one person's tokens with other users.

## Completed API corrections

- `QUOTA_EXCEEDED` is surfaced without retry. Development Mode quota is shared
  across the developer account. No universal reset time is promised.
- Ordinary rate limits are retried only when the full `Retry-After` fits the
  bounded wait; longer waits are returned to the caller without retrying early.
- Account allowlists accept email, user ID and immutable account ID. Prefer IDs.
- Redirect documentation uses `127.0.0.1`, not `localhost`.
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

Verified on this update: `pnpm check` passes (86 workerd tests, seven Node auth
tests, 680.15 KiB gzip). The actual `pnpm --silent stdio` process passes discovery,
ping, competing-owner rejection, signout and missing-login checks with isolated
synthetic tokens. Read-only live calls through the shared MCP core pass profile,
per-type offset search, artist membership, bounded playlist pagination and playback
state using an existing grant. The browser documentation renders on desktop/mobile.

Fresh local Spotify consent and real upstream token rotation remain pre-deployment
checks. The existing Python grant lacks some canonical scopes, and the new local
entrypoint correctly refuses that incomplete grant rather than silently proceeding.
PKCE callbacks and rotation are covered with simulated upstream responses, not a
claim that a new Spotify login or deployed Worker refresh was exercised.

## Remaining decisions

- Migrate McpAgent/SDK v1 to the supported stateless handler/SDK v2 only after
  defining a single authoritative upstream-token owner per grant and a tested
  existing-grant migration. Account for simultaneous sessions and refresh rotation.
- Configure canonical resource/audience binding and evaluate CIMD with safe
  metadata fetching. Preserve deliberate legacy-client compatibility rather than
  equating DCR support with current-protocol conformance.
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

Podcasts, audiobooks, chapters and resume points remain out of scope without a
concrete workflow. Following users, playlist-image reads and followed-artist
cursor pagination are separate needs, not automatic additions for endpoint parity.
No new insight/analytics service or mixed Spotify/SoundCloud player is being built.
Borrow SoundCloud's local/remote architecture, not its content or credentials.
