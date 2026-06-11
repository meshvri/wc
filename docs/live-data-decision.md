# Live-data approach — decision

**Date:** 2026-06-11
**Decision:** Cron stays the single source of truth. The browser **self-refreshes our own
`data/tournament.json`** (same-origin, no key) during match windows for no-reload
freshness. **No elapsed match minute is shown** — no free source delivers one accurately.

## Options evaluated (against this architecture: static GitHub Pages, `/wc/` subpath, existing cron)

### 1. Cron-only (chosen as the data backbone)
The GitHub Action fetches results server-side and commits `tournament.json`; the page reads
that committed file. Already in place. "Live" = LIVE pill + border + score as of the last
refresh. No browser API dependency, no key exposure, no CORS risk. The static 104-match
fallback always renders.

### 2. Client-side live refresh from a third-party API (rejected for scores/minute)
Probed the realistic free sources for browser use:

| Source | WC 2026 coverage | Browser CORS | Free live minute? | Key in browser? |
|---|---|---|---|---|
| **football-data.org** | Good | **No** — `405` + no `Access-Control-Allow-Origin`; server-side only | n/a | would leak |
| **TheSportsDB v1 `eventsseason`** | Yes (real 2026 fixtures verified) | **Yes** — `Access-Control-Allow-Origin: *` | No (scores + half status only, delayed) | key in path (free `3`) |
| **TheSportsDB v2 `livescore`** (the only "minute" feed) | Yes | Yes | Yes, but **requires a paid/Patreon key** | would leak a paid key |

So an accurate **elapsed minute** is only behind a paid key. Per the project guardrail we do
not ship that, and we do not expose keys in client code. `eventsseason` *is* CORS-enabled and
free, but it only adds a score/half-status we already get via cron, while adding a second
source of truth, rate-limit exposure, and drift between the page and the committed bracket
that the auto-progression engine depends on. Not worth it.

### 3. Tighter cron during match windows (adopted, already configured)
The Action already runs every 2h plus half-hourly during the prime UTC match windows
(18:00–05:59). GitHub cron is best-effort and often delayed several minutes, so this is "near
live", not real-time — which is the honest ceiling for a free, keyless, static-hosted site.

## What ships for the Now/Next pill (#3)
- **Live match:** shows the teams + current **score** + a `LIVE` indicator. **No minute.**
- **No live match:** shows a **countdown** to the next kickoff ("in 2h 14m") and the fixture.
- The page **self-refreshes `tournament.json`** every 60s while the document is visible and a
  match is live or within ~30 min of kickoff / ~2.5h after, so committed score changes appear
  without a manual reload. The service worker serves this file **network-first** so the cache
  never freezes results.
