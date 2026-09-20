# Working on this repo

## The test suite will lie to you

The Worker tests run offline against `src/fake-spotify.ts`. On 2026-07-26 all
42 tests passed while **every one of the then-24 tools was dead in production**.
Three separate bugs sat exactly where the suite substitutes a fake:

- the fake injects an arrow-function `fetchImpl`, so the real `fetch`'s receiver
  check — a genuine "Illegal invocation" crash in workerd — was unobservable;
- `SPOTIFY_SCOPES` is configuration no fake consults, so two tools that could
  never have worked looked fine;
- no test drives `withFallback` with a real 400, so its threshold was wrong.

Adding tests against that same fake would have raised coverage and caught none
of it. **Green tests are necessary, not sufficient.** After changing
`src/spotify.ts`, `src/endpoints.ts`, or the scopes in `src/utils.ts`, verify
with live MCP tool calls before reporting done. Prefer real infrastructure over
new mocks; where a fake is unavoidable, treat everything behind it as untested
and cover it in `scripts/e2e.ts` instead.

## Two traps when verifying live

**Scope changes need the user to re-authenticate.** Adding a scope to
`SPOTIFY_SCOPES` does not upgrade the existing token — it keeps the scopes it was
minted with. Ask the user to run `/mcp` and reconnect, then retest.

Reconnecting alone used to be insufficient: the Durable Object seeded its token
once and then refreshed the old grant forever, so a new scope could never take
effect. It now stores the grant's `scope` and re-seeds from `props` whenever that
string changes. If a tool still reports a missing scope after a reconnect, check
that comparison in `init()` before suspecting Spotify's consent screen.

**`withFallback` caches per Durable Object.** A fallback fix may not take effect
until the DO restarts, so a retest immediately after `wrangler deploy` can still
show the old failure. If a fix looks like it didn't work, wait and retry before
concluding it's wrong.

## Regimes

Feb 2026 split apps into a **full/legacy** and a **restricted** regime with
different endpoint shapes. `withFallback` in `src/spotify.ts` tries restricted
first, falls back to legacy, and caches the answer per family.

Past live probes found full/legacy responses for this app. That is an observation,
not its permanent access contract: Spotify postponed the March 9 endpoint rollout
for existing integrations. Check current official guidance and observed responses.
Fields restricted mode strips (`followers`, `popularity`, `email`, `country`,
`product`) stay optional in `src/types.ts`.

Run `/spotify-api-watch` to check for upstream changes and probe which regime
we're actually on. It's also the right reflex when a tool starts failing in a way
that smells upstream: a sudden 400/403 on something that worked, missing fields,
or shrunken result counts.

## Known upstream quirk, don't chase it

Playlists read back as `public: true` even when created with `public: false` and
then explicitly PUT back to false. Our request body is correct
(`endpoints.ts` sends `public: options.isPublic ?? false`). This is Spotify's
reporting; there is nothing to fix. When a user asks for a private playlist,
create it private and tell them to confirm in the Spotify app.

## New tools need annotations

Every tool declares MCP behaviour hints, and `pnpm check:meta` fails without
them. Get `destructiveHint` right rather than safe-by-default: clients use it to
decide what to confirm with the user, so marking an additive tool destructive
trains people to click through the prompts that matter. Destructive means
overwrites or deletes existing data (`remove_saved_tracks`, `unfollow_playlist`,
`reorder_playlist`), not merely "writes" (`save_tracks`, `add_to_queue`).

Guidance that applies to the whole surface goes in `INSTRUCTIONS` at the top of
the shared server/tool setup, not every tool description. It ships once per
session; keep descriptions within the metadata budget.

## Canonical local and remote implementation

New Spotify API/tool work starts here. Local stdio and the Worker must consume
the same tool registrar and endpoint layer. Keep filesystem/process/browser
concerns out of the shared core and Cloudflare-specific imports out of stdio.
The Python sibling remains supported; document real contract differences rather
than calling equal versions feature parity.

Local login uses PKCE and loopback-only callbacks. Token files stay private,
schema-validated and atomically replaced; refresh rotation must persist before
returning a token. Never log tokens or read secret-bearing files into an agent's
context. Use explicit auth commands, not browser launches during MCP startup.

`Retry-After` is a minimum, not a value to clamp downward. Surface long waits;
never retry `QUOTA_EXCEEDED` or promise a reset interval Spotify has not documented.
July 2026 allows 25 Client IDs but shares Development Mode quota per developer.

Annotations are client hints, not authorization or human consent. Removal
elicitation must fail closed on rejection/error when supported. Preserve optional
snapshot guards, paging positions and genuine MCP output schemas.

Public availability needs Spotify policy clearance, not just working OAuth.
Its policy restricts AI ingestion beyond training. Never assume an unset
allowlist is private or silently open enrollment. Keep deployment and credential
changes separate from code commits unless the user authorizes them.

## Before finishing

```sh
pnpm check    # everything CI runs: lint, markdownlint, typecheck, meta, tests, size, security
```

`pnpm check` covers the repository quality gates, not live account behavior.
Report exactly which runtime paths were exercised and which need account consent
or a deployment. Keep `PLAN.md` current after substantial changes.
