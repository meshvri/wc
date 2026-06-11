# Live-data approach — decision

> **UPDATE 2026-06-11 (supersedes the original decision below): FIFA official feed is now the
> primary source, and a key-free live layer DOES show the elapsed minute.** See next section.

## FIFA official feed — primary (key-free, CORS-open, live minute)

**Decision:** Use FIFA's public app feed `api.fifa.com` as the authoritative primary source,
both server-side (cron) and as a client-side live overlay. football-data.org is automatic
fallback #2, TheSportsDB #3. The static 104-match file remains the offline fallback.

Verified live on 2026-06-11 (opening day, opener in progress):
- `GET /api/v3/calendar/matches?idCompetition=17&idSeason=285023&count=500&language=en`
  → **HTTP 200, CORS `Access-Control-Allow-Origin: *`, 104 matches**, with `HomeTeamScore` /
  `AwayTeamScore`, `HomeTeamPenaltyScore` / `AwayTeamPenaltyScore`, `MatchStatus` (3 = live),
  `MatchTime` (e.g. `"27'"`), and stage. **The calendar updates live** (opener read
  `1–0, 27'` in real time).
- `MatchNumber` (1..104) maps **1:1** onto our match ids — overlay is exact, no fuzzy
  matching. Stages map by number range (1–72 group, 73–88 R32, … 104 final). Upcoming
  matches report `null` scores (not 0), so a not-started match is never mis-marked 0–0.
- idCompetition `17` = FIFA World Cup, idSeason `285023` = 2026.

**Cron (`scripts/update-data.mjs → fromFIFA`)** overlays scores/penalties/derived-winner by
match number; `meta.source` reads `api.fifa.com`. **Client live layer (`app.js`)** polls the
same calendar every ~45s while a WC match is live and the tab is visible, overlaying goals +
minute onto rows + the Now/Next pill (e.g. `🇲🇽 1–0 🇿🇦 LIVE 27'`). It is **overlay-only**
(`LIVE_OV`, never mutates committed data or the bracket), pauses when hidden, backs off on
error, and falls back silently to the committed cron data.

FIFA is undocumented, so every call degrades gracefully: a non-200 / unexpected shape falls
back to football-data.org automatically. Polling is polite (≥45s, exponential backoff).

**API-Football (api-sports.io) — rejected.** Its free plan is paywalled for 2026
(`/fixtures?league=1&season=2026` → 0 results, "Free plans do not have access to this season,
try from 2022 to 2024"). Not wired in.

---

## Original decision (now the fallback layer)

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

## Knockout result correctness — extra time & penalties (2026-06-11)

A knockout that ends level is decided in extra time or on penalties. The bracket must advance
the actual winner, not stall on a level score.

### How each source carries this
- **football-data.org v4** (`/competitions/WC/matches`): the `score` object carries
  `winner` (`HOME_TEAM`/`AWAY_TEAM`/`DRAW`), `duration` (`REGULAR`/`EXTRA_TIME`/
  `PENALTY_SHOOTOUT`), and `penalties: {home, away}`. `fullTime` is the score after regular +
  extra time (so a shootout match reads e.g. `1-1` with `winner: AWAY_TEAM`). This is the only
  source that can drive the knockout stage: it tags each match with a `stage`
  (`ROUND_OF_16`, …) and gives a decided winner. **The updater uses it as primary when
  `FOOTBALL_DATA_TOKEN` is set.**
- **TheSportsDB `eventsseason`** (no key): does **not** expose a winner, penalties, or a usable
  knockout-stage label (probed: `strStage`/`strRound` came back undefined). It can overlay
  group results by team pair but **cannot resolve knockout ties**. It is the fixtures/back-up
  source only.

### Coverage proof status — VERIFIED (2026-06-11)
A valid `football-data.org` token was tested directly:
- `GET /v4/competitions/WC/matches` → **HTTP 200, 104 matches, season 2026**, with every stage
  present: `GROUP_STAGE, LAST_32, LAST_16, QUARTER_FINALS, SEMI_FINALS, THIRD_PLACE, FINAL`.
- All **32 knockout fixtures map one-to-one** onto our bracket slots by stage + nearest
  kickoff (no collisions), and all 72 group fixtures are present — so live results overlay the
  correct slot and the engine advances the right team.
- The cron now logs `Source: football-data.org · 104 events seen`; committed
  `meta.source = "football-data.org"`.
- **Free-tier limits found:** historical seasons are gated (`?season=2022` → HTTP 403), and
  today is the opening day (all matches `TIMED`, `played: 0`), so a real penalty `score`
  object cannot be sampled until the Round of 32 (28 Jun). The v4 `score` schema above is the
  documented contract; the engine chain is proven against it by `scripts/test-knockout.mjs`.

**Also evaluated and rejected: API-Football (api-sports.io) free tier** — its World Cup league
lists season 2026 in metadata, but `GET /fixtures?league=1&season=2026` returns
`"Free plans do not have access to this season, try from 2022 to 2024."` (0 fixtures). It
cannot serve the 2026 tournament on the free plan, so it is not wired in.

### Safety net (source-agnostic)
If any source reports a knockout as finished and level but provides **no winner**, the updater
writes `result_pending: true` (it does not invent a winner), and the engine renders the tie as
**"result pending"** rather than a settled result. The downstream slot stays a placeholder, so
a missing shootout result is visible instead of silently dead-ending the bracket. Extra-time
and penalty results render as `AET` / `FT · PENS`.
