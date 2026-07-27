# Working on this repo

## The test suite will lie to you

`pnpm test` runs 42 tests fully offline against `src/fake-spotify.ts`. On
2026-07-26 all 42 passed while **every one of the 24 tools was dead in
production**. Three separate bugs sat exactly where the suite substitutes a fake:

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

**`withFallback` caches per Durable Object.** A fallback fix may not take effect
until the DO restarts, so a retest immediately after `wrangler deploy` can still
show the old failure. If a fix looks like it didn't work, wait and retry before
concluding it's wrong.

## Regimes

Feb 2026 split apps into a **full/legacy** and a **restricted** regime with
different endpoint shapes. `withFallback` in `src/spotify.ts` tries restricted
first, falls back to legacy, and caches the answer per family.

This app currently gets the **full/legacy** regime for every family probed,
despite being development-mode and therefore due for restriction. Don't rely on
it. Response fields that restricted mode strips (`followers`, `popularity`,
`email`, `country`, `product`) are all `nullish()` in `src/types.ts` — keep them
that way, and never make a stripped-in-restricted field required.

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

## Before finishing

```sh
pnpm check    # everything CI runs: lint, markdownlint, typecheck, meta, tests, size, security
```

`pnpm check` must be green — it mirrors CI exactly, so a green local check means
a green build. Keep `PLAN.md` current after substantial work; it's the living
status doc another session resumes from, and it carries an exec summary plus the
TODO list at the top.
