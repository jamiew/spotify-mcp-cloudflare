---
name: spotify-api-watch
description: Check for Spotify Web API changes and verify this server still matches them. Use when the user says "check the Spotify API", "any Spotify API changes", "/spotify-api-watch", before a release, or on a schedule. Also use when a Spotify tool starts failing in a way that smells like an upstream change (sudden 403/400 on a tool that used to work, missing response fields, shrunken result counts).
---

# Spotify API watch

Spotify ships breaking changes to the Web API with little notice and no RSS feed.
This skill answers two questions: **what did Spotify change**, and **does our server
still work**. Do both — a clean changelog does not mean nothing broke, because the
regime flip described below happens silently.

## 1. Changelog sweep

```sh
node --experimental-strip-types scripts/spotify-api-watch.ts
```

Exit 1 means there are unreviewed entries. Spotify publishes no feed and no
changelog index, so this probes the predictable per-month URLs
(`.../references/changes/<month>-<year>`) and diffs against
`scripts/spotify-api-seen.json`.

For each `NEW` URL, fetch it and classify every item as:

- **Breaks us** — an endpoint in `src/endpoints.ts` or a field in `src/types.ts`.
- **Unlocks something** — new capability worth a tool or a scope.
- **Irrelevant** — dashboard/quota/billing with no code impact.

Then re-run with `--accept` to record them as reviewed, and commit the updated JSON.
Only accept after you have actually read the entries.

## 2. Live conformance probe

The changelog tells you what Spotify announced; this tells you what our app
actually gets. Requires the MCP server connected (`/mcp`) — ask the user to
reconnect if the tools are absent.

Run these and compare against the expectations:

| Call | Full/legacy regime | Restricted regime |
| --- | --- | --- |
| `get_me` | returns `email`, `country`, `product` | id only |
| `get_artist_details` on any artist | has `followers`, `popularity` | both absent |
| `search_music` with `limit: 20` | can return >10 | capped at 10 |
| `save_tracks` on one id | succeeds via legacy `/me/tracks` | succeeds via `/me/library` |

As of 2026-07-27 this app is on the **full/legacy** regime for every family
probed, despite being a development-mode app that the February 2026 changes
should have restricted. Treat that as luck, not a guarantee.

**If the probe shows a flip to restricted**, expect these to matter:

- `search_music` max drops 50 → 10 (our schema still advertises 50).
- Artist `followers`/`popularity` and user `email`/`country`/`product` vanish.
  Schemas already mark these `nullish()`, so they degrade rather than throw —
  but the `ALLOWED_EMAILS` allowlist silently stops matching on email.
- Library writes move to `/me/library`. `withFallback` handles this
  automatically, but it caches per Durable Object, so the first call after a
  flip may fail before it settles.

## 3. Report

Lead with whether anything is broken or newly possible. If nothing changed, say
so in one line — do not pad. When something did change, give the user a numbered
list of concrete options (fix X, adopt Y, ignore Z) with a recommendation.

Update the tracking section in `README.md` and the status block in `PLAN.md` if a
change alters what this server supports.

## Running it on a schedule

Steps 1 and 3 need no auth and are safe to automate. Step 2 needs a live MCP
connection, so a scheduled run should either skip it or hit the deployed Worker
directly. To alert rather than auto-change anything, run the sweep and let the
nonzero exit drive the notification — do not pass `--accept` unattended, since
that marks entries reviewed without anyone reading them.

## Sources

- Changelog — `https://developer.spotify.com/documentation/web-api/references/changes/<month>-<year>` (no index page; probe by URL)
- [Feb 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) — development vs extended, and what each loses
- [Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)
- [Developer community forum](https://community.spotify.com/t5/Spotify-for-Developers/bd-p/Spotify_Developer) — where undocumented breakage surfaces first, usually days before the changelog
- [Official TS SDK](https://github.com/spotify/spotify-web-api-ts-sdk) — we do not depend on it, but its issues are an early warning signal
