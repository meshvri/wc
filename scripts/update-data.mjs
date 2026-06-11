#!/usr/bin/env node
// update-data.mjs — overlay live scores/status onto the static fixtures.
//
// Hard rule (matches the project guardrail): this NEVER drops or reorders the
// fallback schedule. It only mutates home_score / away_score / status / winner
// on matches that already exist in data/tournament.json. If every source is
// unreachable, the full 104-match schedule still renders untouched.
//
// Sources, in priority order:
//   1. football-data.org  (set FOOTBALL_DATA_TOKEN) — clean stage labels.
//   2. TheSportsDB free   (no key needed; THESPORTSDB_KEY optional, default 3).
//
// Group matches are matched by their (unordered) team pair. Knockout matches —
// whose teams are placeholders in the fallback until results resolve them — are
// matched by round + nearest kickoff time, so a score lands on the right slot
// and the engine derives the participants from the bracket.
//
// Run:  node scripts/update-data.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'tournament.json');
const data = JSON.parse(readFileSync(FILE, 'utf8'));

// --- name normalization ----------------------------------------------------
const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// canonical (our) names keyed by every normalized alias we might receive
const ALIASES = {};
const addAlias = (canonical, ...variants) => {
  ALIASES[strip(canonical)] = canonical;
  for (const v of variants) ALIASES[strip(v)] = canonical;
};
for (const teams of Object.values(data.groups)) for (const t of teams) ALIASES[strip(t.name)] = t.name;
addAlias('United States', 'USA', 'United States of America', 'US');
addAlias('South Korea', 'Korea Republic', 'Republic of Korea', 'Korea');
addAlias('Iran', 'IR Iran', 'Islamic Republic of Iran');
addAlias('Türkiye', 'Turkey', 'Turkiye');
addAlias('Czech Republic', 'Czechia');
addAlias('Ivory Coast', "Cote d'Ivoire", 'Côte d’Ivoire');
addAlias('DR Congo', 'Congo DR', 'Democratic Republic of the Congo', 'Congo Democratic Republic');
addAlias('Cape Verde', 'Cabo Verde');
addAlias('Bosnia and Herzegovina', 'Bosnia & Herzegovina', 'Bosnia Herzegovina');
addAlias('Curaçao', 'Curacao');

const canon = (name) => ALIASES[strip(name || '')] || null;

// --- fixture indexes -------------------------------------------------------
const groupByPair = new Map();
for (const m of data.matches) {
  if (m.stage === 'group') groupByPair.set([m.home.name, m.away.name].sort().join(' | '), m);
}
const STAGE_FROM_API = {
  ROUND_OF_32: 'r32', LAST_32: 'r32',
  ROUND_OF_16: 'r16', LAST_16: 'r16',
  QUARTER_FINALS: 'qf', QUARTER_FINAL: 'qf',
  SEMI_FINALS: 'sf', SEMI_FINAL: 'sf',
  THIRD_PLACE: 'third', '3RD_PLACE_FINAL': 'third',
  FINAL: 'final',
};

function applyResult(target, hs, as, statusRaw, winnerRaw, pens, duration) {
  if (!Number.isFinite(hs) || !Number.isFinite(as)) {
    if (statusRaw === 'live') target.status = 'live';
    return false;
  }
  target.home_score = hs;
  target.away_score = as;
  const level = hs === as;
  const isKO = target.stage && target.stage !== 'group';
  const haveWinner = winnerRaw === 'home' || winnerRaw === 'away';
  if (level && haveWinner) target.winner = winnerRaw; // extra time / penalties decided it
  if (pens && Number.isFinite(pens.home) && Number.isFinite(pens.away)) {
    target.home_pens = pens.home; target.away_pens = pens.away;
  }
  if (duration) target.duration = duration;
  // A knockout that finished level but whose winner the source did not provide
  // must NOT be written as a settled result — that silently stalls the bracket.
  // Flag it pending so the gap is visible (the engine renders "result pending").
  if (isKO && level && !haveWinner && statusRaw !== 'live') {
    target.result_pending = true;
    target.status = 'finished';
  } else {
    delete target.result_pending;
    target.status = statusRaw === 'live' ? 'live' : 'finished';
  }
  return true;
}

// match a knockout API fixture to our fixture by round + nearest kickoff
function findKnockout(stage, utcDate) {
  const t = Date.parse(utcDate);
  const cands = data.matches.filter((m) => m.stage === stage);
  let best = null, bestDiff = Infinity;
  for (const m of cands) {
    const d = Math.abs(Date.parse(m.kickoff_utc) - t);
    if (d < bestDiff) { bestDiff = d; best = m; }
  }
  // accept only if within 2 days (guards against mis-mapping)
  return bestDiff <= 2 * 864e5 ? best : null;
}

// --- sources ---------------------------------------------------------------
async function fromFootballData(token) {
  const res = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
    headers: { 'X-Auth-Token': token },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`football-data ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const out = [];
  for (const m of json.matches || []) {
    const st = m.status === 'IN_PLAY' || m.status === 'PAUSED' ? 'live'
      : m.status === 'FINISHED' ? 'finished' : 'scheduled';
    out.push({
      home: m.homeTeam?.name, away: m.awayTeam?.name,
      hs: m.score?.fullTime?.home, as: m.score?.fullTime?.away,
      status: st,
      winner: m.score?.winner === 'HOME_TEAM' ? 'home' : m.score?.winner === 'AWAY_TEAM' ? 'away' : null,
      pens: m.score?.penalties ? { home: m.score.penalties.home, away: m.score.penalties.away } : null,
      duration: m.score?.duration || null, // REGULAR | EXTRA_TIME | PENALTY_SHOOTOUT
      stage: STAGE_FROM_API[m.stage] || (m.stage === 'GROUP_STAGE' ? 'group' : null),
      utcDate: m.utcDate,
    });
  }
  return out;
}

async function fromSportsDB(key) {
  const res = await fetch(`https://www.thesportsdb.com/api/v1/json/${key}/eventsseason.php?id=4429&s=2026`);
  if (!res.ok) throw new Error(`thesportsdb ${res.status}`);
  const json = await res.json();
  const out = [];
  for (const e of json.events || []) {
    const finished = (e.strStatus || '').toLowerCase().includes('match finished') || e.strStatus === 'FT';
    const live = ['1h', '2h', 'ht', 'live', 'et', 'pen'].some((x) => (e.strStatus || '').toLowerCase().includes(x));
    out.push({
      home: e.strHomeTeam, away: e.strAwayTeam,
      hs: e.intHomeScore == null ? NaN : +e.intHomeScore,
      as: e.intAwayScore == null ? NaN : +e.intAwayScore,
      status: finished ? 'finished' : live ? 'live' : 'scheduled',
      // eventsseason exposes no winner/penalty fields, so a level knockout here
      // cannot be resolved and will be flagged result_pending downstream.
      winner: null, pens: null,
      duration: /pen/i.test(e.strStatus || '') ? 'PENALTY_SHOOTOUT'
        : /aet|after extra/i.test(e.strStatus || '') ? 'EXTRA_TIME' : null,
      stage: /group/i.test(e.strStage || e.strRound || '') ? 'group' : null,
      utcDate: e.strTimestamp ? `${e.strTimestamp}Z`.replace(/(\+00:00)?Z$/, 'Z') : (e.dateEvent ? `${e.dateEvent}T${e.strTime || '00:00:00'}Z` : null),
    });
  }
  return out;
}

// --- merge ------------------------------------------------------------------
async function main() {
  const token = (process.env.FOOTBALL_DATA_TOKEN || '').trim() || undefined;
  const sdbKey = process.env.THESPORTSDB_KEY || '3';

  let events = null, source = null;
  if (token) {
    try { events = await fromFootballData(token); source = 'football-data.org'; }
    catch (e) { console.warn('football-data failed:', e.message); }
  }
  if (!events) {
    try { events = await fromSportsDB(sdbKey); source = 'thesportsdb.com'; }
    catch (e) { console.warn('thesportsdb failed:', e.message); }
  }

  if (!events) {
    console.log('No live source reachable — fallback schedule left intact.');
    return; // leave file untouched
  }

  let applied = 0;
  for (const e of events) {
    if (!e.home || !e.away) continue;
    // group → match by team pair
    const pk = [canon(e.home), canon(e.away)].filter(Boolean).sort().join(' | ');
    let target = groupByPair.get(pk);
    // knockout → match by round + nearest kickoff
    if (!target && e.stage && e.stage !== 'group' && e.utcDate) {
      target = findKnockout(e.stage, e.utcDate);
    }
    if (!target) continue;
    if (applyResult(target, e.hs, e.as, e.status, e.winner, e.pens, e.duration)) applied++;
    else if (e.status === 'live') applied++;
  }

  data.meta.updated_utc = new Date().toISOString().replace('.000Z', 'Z');
  data.meta.source = source;
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`Source: ${source} · ${events.length} events seen · ${applied} results overlaid.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
