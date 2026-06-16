// predict-logic.js — pure helpers for the predictions page (no DOM, no network).
// Kept separate from engine.js (tournament logic) and unit-tested directly in
// scripts/test-predict.mjs, so the prediction rules have one source of truth.

// Outcome implied by a scoreline: 'h' (home wins) | 'a' (away wins) | 'd' (draw),
// or null when either score box is empty/non-numeric.
export function scoreOutcome(hs, as) {
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  return hs > as ? 'h' : hs < as ? 'a' : 'd';
}

// Reconcile a winner pick with a typed scoreline. The WRITTEN SCORE is the
// source of truth: when both score boxes are filled the result is derived from
// them, and a pick that disagrees is flagged as a conflict (so the UI can warn
// in Arabic) without ever saving an inconsistent winner.
//   returns { ok, result, conflict, message }
export function reconcilePrediction({ pick = null, hs = NaN, as = NaN } = {}) {
  const fromScore = scoreOutcome(hs, as);
  if (fromScore) {
    const conflict = pick != null && pick !== fromScore;
    return {
      ok: true,
      result: fromScore,
      conflict,
      message: conflict ? 'الفائز لا يطابق النتيجة المكتوبة' : '',
    };
  }
  if (pick === 'h' || pick === 'a' || pick === 'd') {
    return { ok: true, result: pick, conflict: false, message: '' };
  }
  return { ok: false, result: null, conflict: false, message: 'اختر الفائز أو أدخل النتيجة' };
}

// Index of the match to focus when the predictions view opens: the live match
// if any, else the next upcoming (first not yet kicked off), else the last one
// (everything is finished). `matches` must be sorted ascending by kickoff and
// each item needs { status, kickoff } where kickoff is an ISO/parseable string.
// Returns -1 for an empty list.
export function nearestMatchIndex(matches, now = Date.now()) {
  if (!matches || !matches.length) return -1;
  const live = matches.findIndex((m) => m.status === 'live');
  if (live !== -1) return live;
  const upcoming = matches.findIndex((m) => Date.parse(m.kickoff) > now);
  if (upcoming !== -1) return upcoming;
  return matches.length - 1;
}
