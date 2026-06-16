#!/usr/bin/env node
// Deterministic tests for the predictions page pure logic:
//   • reconcilePrediction — the written score is authoritative, and a winner
//     pick that contradicts a complete scoreline is flagged (Arabic warning)
//     rather than silently saved wrong.
//   • nearestMatchIndex — which match the view scrolls to on open.
//
// Run: node scripts/test-predict.mjs   (exit 0 = all pass)
import { scoreOutcome, reconcilePrediction, nearestMatchIndex } from '../assets/predict-logic.js';

let failures = 0;
const ok = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); } else { console.error(`  ✗ ${msg}`); failures++; } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)})`);

console.log('scoreOutcome:');
eq(scoreOutcome(2, 0), 'h', 'home win');
eq(scoreOutcome(0, 2), 'a', 'away win');
eq(scoreOutcome(1, 1), 'd', 'draw');
eq(scoreOutcome(NaN, 0), null, 'missing home');
eq(scoreOutcome(2, NaN), null, 'missing away');

console.log('\nreconcilePrediction — score is the source of truth:');
{
  // the user's exact complaint: score 2-0 but picked "away wins"
  const r = reconcilePrediction({ pick: 'a', hs: 2, as: 0 });
  ok(r.ok && r.result === 'h', 'score 2-0 + pick away  -> result stays home (score wins)');
  ok(r.conflict === true, 'contradiction is flagged as a conflict');
  ok(/[؀-ۿ]/.test(r.message), 'conflict message is in Arabic');
}
{
  const r = reconcilePrediction({ pick: 'h', hs: 2, as: 0 });
  ok(r.ok && r.result === 'h' && !r.conflict, 'score 2-0 + pick home  -> agree, no conflict');
}
{
  const r = reconcilePrediction({ pick: 'a', hs: 1, as: 1 });
  ok(r.ok && r.result === 'd' && r.conflict, 'score 1-1 + pick away  -> draw, conflict flagged');
}
{
  const r = reconcilePrediction({ pick: 'a', hs: NaN, as: NaN });
  ok(r.ok && r.result === 'a' && !r.conflict, 'pick only, no score    -> use the pick');
}
{
  const r = reconcilePrediction({ pick: null, hs: NaN, as: NaN });
  ok(!r.ok && /[؀-ۿ]/.test(r.message), 'nothing entered        -> not ok, Arabic prompt');
}
{
  // half a scoreline is not a complete score -> falls back to the pick
  const r = reconcilePrediction({ pick: 'h', hs: 2, as: NaN });
  ok(r.ok && r.result === 'h' && !r.conflict, 'half score + pick      -> use the pick, no conflict');
}

console.log('\nnearestMatchIndex:');
const T = (h) => new Date(Date.UTC(2026, 5, 16, h, 0, 0)).toISOString();
const now = Date.UTC(2026, 5, 16, 12, 0, 0);
{
  // all finished earlier today + a couple upcoming later
  const ms = [
    { status: 'finished', kickoff: T(8) },
    { status: 'finished', kickoff: T(10) },
    { status: 'upcoming', kickoff: T(14) },
    { status: 'upcoming', kickoff: T(17) },
  ];
  eq(nearestMatchIndex(ms, now), 2, 'no live -> first upcoming after now');
}
{
  const ms = [
    { status: 'finished', kickoff: T(8) },
    { status: 'live', kickoff: T(11) },
    { status: 'upcoming', kickoff: T(14) },
  ];
  eq(nearestMatchIndex(ms, now), 1, 'a live match wins over upcoming');
}
{
  const ms = [
    { status: 'finished', kickoff: T(8) },
    { status: 'finished', kickoff: T(10) },
  ];
  eq(nearestMatchIndex(ms, now), 1, 'everything finished -> last match');
}
eq(nearestMatchIndex([], now), -1, 'empty list -> -1');

console.log(failures ? `\n${failures} FAILED` : '\nAll predict-logic tests passed ✓');
process.exit(failures ? 1 : 0);
