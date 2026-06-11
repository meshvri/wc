#!/usr/bin/env node
// Builds data/tournament.json from scripts/source-data.json.
// - Converts each match's local kickoff (in the venue's IANA timezone) to a
//   UTC instant, DST-correct, going through the Intl timezone API (never a
//   hardcoded offset).
// - Normalizes groups, venues and all 104 matches into the schema the site
//   and the updater share.
//
// Run:  node scripts/build-fixtures.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const src = JSON.parse(readFileSync(join(__dirname, 'source-data.json'), 'utf8'));

// --- timezone math ---------------------------------------------------------
// Offset (ms) of a zone at a given UTC instant, derived purely from Intl.
function tzOffsetMs(tz, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return asUTC - utcMs;
}

// Convert a wall-clock time in `tz` to a UTC ISO string.
function zonedToUtcISO(dateStr, timeStr, tz) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  let utc = Date.UTC(Y, M - 1, D, h, m);
  // Two iterations converge even across DST boundaries.
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMs(tz, utc);
    utc = Date.UTC(Y, M - 1, D, h, m) - off;
  }
  return new Date(utc).toISOString().replace('.000Z', 'Z');
}

// --- team lookup -----------------------------------------------------------
const teamByName = new Map();
for (const [g, teams] of Object.entries(src.groups)) {
  for (const t of teams) teamByName.set(t.name, { name: t.name, code: t.code, group: g });
}
function team(name) {
  const t = teamByName.get(name);
  if (!t) throw new Error(`Unknown team: ${name}`);
  return { name: t.name, code: t.code };
}

// --- assemble matches ------------------------------------------------------
const matches = [];

for (const gm of src.group_matches) {
  matches.push({
    id: gm.match,
    stage: 'group',
    group: gm.group,
    kickoff_utc: zonedToUtcISO(gm.date, gm.kickoff_local, gm.tz),
    venue: gm.venue,
    city: gm.city,
    home: team(gm.home),
    away: team(gm.away),
    home_feed: null,
    away_feed: null,
    home_score: null,
    away_score: null,
    status: 'upcoming',
  });
}

const STAGE_KEYS = { R32: 'r32', R16: 'r16', QF: 'qf', SF: 'sf', '3RD': 'third', FINAL: 'final' };
for (const [key, list] of Object.entries(src.knockout_structure)) {
  for (const km of list) {
    matches.push({
      id: km.match,
      stage: STAGE_KEYS[key],
      group: null,
      kickoff_utc: zonedToUtcISO(km.date, km.kickoff_local, km.tz),
      venue: km.venue,
      city: km.city,
      home: null,            // resolved at render time from home_feed
      away: null,
      home_feed: km.home_feed,
      away_feed: km.away_feed,
      home_score: null,
      away_score: null,
      status: 'upcoming',
    });
  }
}

matches.sort((a, b) => a.id - b.id);

const out = {
  meta: {
    name: 'FIFA World Cup 2026',
    subtitle: 'United States · Canada · Mexico',
    start: '2026-06-11',
    end: '2026-07-19',
    display_tz: 'Asia/Riyadh',
    display_tz_label: 'Riyadh',
    total_matches: matches.length,
    updated_utc: null,        // stamped by the updater; null = static fallback
    source: 'static-fallback',
  },
  groups: src.groups,
  venues: src.venues,
  matches,
};

if (matches.length !== 104) throw new Error(`Expected 104 matches, got ${matches.length}`);

writeFileSync(join(ROOT, 'data', 'tournament.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote data/tournament.json — ${matches.length} matches.`);
console.log(`First kickoff (UTC): ${matches[0].kickoff_utc}`);
console.log(`Final  kickoff (UTC): ${matches[103].kickoff_utc}`);
