# World Cup 2026 — Riyadh-time schedule

A creatively-designed, iPhone-first interactive schedule for the 2026 FIFA World Cup
(11 June – 19 July 2026, hosted by USA / Canada / Mexico). Every one of the 104 matches,
shown with national flags and **Riyadh-time** kickoffs, with live scores and a knockout
bracket that fills itself in from results — zero manual work.

**Live:** https://meshvri.github.io/wc

## Why it exists

Most 2026 kickoffs land late at night / early morning in Riyadh. This site is built
around that: times are rendered through the `Asia/Riyadh` timezone, matches are grouped
under the correct Riyadh calendar day, and after-midnight games get a clear `🌙 night`
badge so a 03:00 kickoff is never ambiguous about which day it belongs to.

## Companion features

- **Follow teams** — tap the star on any team to pin it (Saudi Arabia is pinned by
  default). Pinned teams get a "Your teams" strip at the top of Matches showing each one's
  next match, and their rows are highlighted across Matches, Groups and Bracket. Stored in
  `localStorage`.
- **Now / Next pill** — a floating pill shows the live match (score) or a countdown to the
  next kickoff, and taps back to it. Live results refresh in-browser during match windows
  without a reload. See [`docs/live-data-decision.md`](docs/live-data-decision.md) for why
  there is no elapsed-minute (no free, keyless source provides one accurately).
- **Group drama** — group tables show "Through / Out / Plays for 2nd"-style tags and a
  "Matchday X of 3" marker, derived from the standings math.
- **Installable PWA** — add to Home Screen for an app-like, offline-capable experience. The
  shell is cached cache-first; `data/tournament.json` is **network-first**, so auto-updated
  results are never frozen by the cache.

## How it works

- **Static site** — vanilla HTML/CSS/JS, no build step. GitHub Pages serves it from the
  `main` branch root.
- **`data/tournament.json`** — the single source of truth: tournament meta, the 12-group
  draw, 16 venues, and all 104 matches with UTC kickoffs. Generated from
  `scripts/source-data.json` by `scripts/build-fixtures.mjs` (which converts each venue's
  local kickoff to UTC, DST-correct, via the timezone API).
- **`assets/engine.js`** — pure logic. Computes group standings, the 8 best third-placed
  teams, resolves every knockout placeholder (`Winner Group A`, `Winner Match 73`,
  `3rd Group A/B/C/D/F`, …) into a real team once its feeders finish, and derives each
  match's status (upcoming / live / finished). The bracket auto-progresses purely from
  dates + results.
- **`assets/app.js`** — renders the three views (Matches, Groups, Bracket), all in Riyadh
  time.
- **`scripts/update-data.mjs`** — overlays live scores/status onto the static fixtures.
  It **never** drops the fallback schedule; if every source is down, the full schedule
  still renders. Sources: football-data.org (if `FOOTBALL_DATA_TOKEN` is set) or
  TheSportsDB (no key).
- **`.github/workflows/update.yml`** — a cron Action runs the updater and commits
  `data/tournament.json` when it changes. Each commit redeploys Pages.

## Local development

```bash
node scripts/build-fixtures.mjs        # regenerate data/tournament.json from source
python3 -m http.server 8000            # then open http://localhost:8000
node scripts/update-data.mjs           # manually pull live results (optional)
```

## Optional: keyed data source

```bash
gh secret set FOOTBALL_DATA_TOKEN --repo meshvri/wc   # free token from football-data.org
```

Without it, the updater uses TheSportsDB and needs no secret.
