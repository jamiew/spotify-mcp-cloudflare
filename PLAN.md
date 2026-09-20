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

Release checks pass 89 workerd tests and seven Node auth tests, with a 688.58 KiB
gzip bundle. Tests use the shared server factory and reject dynamic code generation
during playlist-removal confirmation, matching the Worker runtime restriction.
The actual stdio process passes discovery, ping, competing-owner rejection, signout
and missing-login checks with isolated synthetic tokens.

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
