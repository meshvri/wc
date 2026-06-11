#!/usr/bin/env node
// Deterministic test for knockout result correctness: extra time + penalties.
// Proves the full chain — a finished knockout that is level resolves to the
// correct next-round team only when a winner is known, and a level tie WITHOUT
// a winner stays unresolved and is flagged "pending" (never silently finished).
//
// Run: node scripts/test-knockout.mjs   (exit 0 = all pass)
import { readFileSync } from 'node:fs';
import { resolve, displayStatus, resultLabel } from '../assets/engine.js';

let failures = 0;
const ok = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); } else { console.error(`  ✗ ${msg}`); failures++; } };

function freshData() {
  const data = JSON.parse(readFileSync(new URL('../data/tournament.json', import.meta.url), 'utf8'));
  // complete every group so all R32 slots resolve to concrete teams
  for (const m of data.matches.filter((x) => x.stage === 'group')) {
    m.home_score = 2; m.away_score = 0; m.status = 'finished';
  }
  return data;
}

const byId = (data, id) => data.matches.find((m) => m.id === id);
const winnerCodeOf = (resolved, m, side) => {
  const r = resolved.get(m.id);
  const s = side === 'home' ? r.home : r.away;
  return s && s.code;
};

// R32 match 73 (Runner-up A vs Runner-up B) feeds R16 match 90 home ("Winner Match 73")
const KO = 73, NEXT = 90;
const now = Date.parse('2026-06-30T00:00:00Z');

console.log('Case A — penalty shootout resolves the correct team:');
{
  const data = freshData();
  let r = resolve(data, now);
  const homeTeam = winnerCodeOf(r.resolved, byId(data, KO), 'home'); // Runner-up A
  const awayTeam = winnerCodeOf(r.resolved, byId(data, KO), 'away'); // Runner-up B
  const m = byId(data, KO);
  m.home_score = 1; m.away_score = 1; m.status = 'finished';
  m.winner = 'away'; m.home_pens = 3; m.away_pens = 4; m.duration = 'PENALTY_SHOOTOUT';
  r = resolve(data, now);
  ok(displayStatus(m, now) === 'finished', 'level tie with a winner is finished');
  ok(resultLabel(m) === 'FT · PENS', 'label is "FT · PENS"');
  const slot = r.resolved.get(NEXT).home;
  ok(slot && !slot.placeholder && slot.code === awayTeam, `match ${NEXT} home advances the shootout winner (away)`);
  ok(awayTeam !== homeTeam, 'sanity: the two teams differ');
}

console.log('Case B — level tie with NO winner stays pending and does not advance anyone:');
{
  const data = freshData();
  const m = byId(data, KO);
  m.home_score = 1; m.away_score = 1; m.status = 'finished'; // no winner field
  const r = resolve(data, now);
  ok(displayStatus(m, now) === 'pending', 'level knockout without a winner is "pending", not "finished"');
  const slot = r.resolved.get(NEXT).home;
  ok(slot && slot.placeholder, `match ${NEXT} home stays a placeholder (no wrong team advanced)`);
}

console.log('Case C — extra-time winner resolves normally (AET):');
{
  const data = freshData();
  let r = resolve(data, now);
  const homeTeam = winnerCodeOf(r.resolved, byId(data, KO), 'home');
  const m = byId(data, KO);
  m.home_score = 2; m.away_score = 1; m.status = 'finished'; m.duration = 'EXTRA_TIME';
  r = resolve(data, now);
  ok(displayStatus(m, now) === 'finished', 'decisive ET result is finished');
  ok(resultLabel(m) === 'AET', 'label is "AET"');
  const slot = r.resolved.get(NEXT).home;
  ok(slot && !slot.placeholder && slot.code === homeTeam, `match ${NEXT} home advances the ET winner (home)`);
}

console.log('Case D — explicit result_pending marker is honored:');
{
  const data = freshData();
  const m = byId(data, KO);
  m.home_score = 1; m.away_score = 1; m.status = 'finished'; m.result_pending = true;
  ok(displayStatus(m, now) === 'pending', 'result_pending marker forces "pending"');
}

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURE(S) ❌`);
process.exit(failures === 0 ? 0 : 1);
