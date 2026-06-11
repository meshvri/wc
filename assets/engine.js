// engine.js — pure tournament logic, no DOM.
// Given the normalized tournament.json, this derives:
//   • group standings (FIFA points / GD / GF ordering)
//   • the 8 best third-placed teams
//   • resolution of every knockout placeholder ("Winner Group A",
//     "Runner-up Group C", "Winner Match 73", "3rd Group A/B/C/D/F", ...)
//     into a concrete {name, code} once the feeding results exist
//   • a display status for each match (upcoming / live / finished)
//
// It NEVER mutates the input. Everything is derived on read so the page
// auto-progresses purely from dates + results in the committed JSON.

const LIVE_WINDOW_MS = 135 * 60 * 1000; // ~kickoff + stoppage; used only when the feed gives no explicit status

// --- result helpers --------------------------------------------------------
export function hasScore(m) {
  return Number.isFinite(m.home_score) && Number.isFinite(m.away_score);
}

export function displayStatus(m, now = Date.now()) {
  // an explicit live flag wins even when a running score is present
  if (m.status === 'live') return 'live';
  if (m.status === 'finished' || hasScore(m)) return 'finished';
  const ko = Date.parse(m.kickoff_utc);
  if (Number.isNaN(ko)) return 'upcoming';
  if (now >= ko && now < ko + LIVE_WINDOW_MS) return 'live';
  return 'upcoming';
}

// Winner / loser of a played knockout match, accounting for a penalty
// shootout via an optional `winner` field ("home" | "away") the updater can set.
function outcome(m) {
  if (!hasScore(m)) return { winner: null, loser: null };
  if (m.home_score > m.away_score) return { winner: 'home', loser: 'away' };
  if (m.away_score > m.home_score) return { winner: 'away', loser: 'home' };
  if (m.winner === 'home' || m.winner === 'away') {
    return { winner: m.winner, loser: m.winner === 'home' ? 'away' : 'home' };
  }
  return { winner: null, loser: null }; // drawn, shootout result unknown
}

// --- group standings -------------------------------------------------------
export function computeStandings(data) {
  const tables = {};
  for (const [g, teams] of Object.entries(data.groups)) {
    tables[g] = {};
    teams.forEach((t, seed) => {
      tables[g][t.name] = {
        team: t, seed, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0,
      };
    });
  }

  const groupMatches = data.matches.filter((m) => m.stage === 'group' && hasScore(m));
  for (const m of groupMatches) {
    const row = tables[m.group];
    const h = row[m.home.name];
    const a = row[m.away.name];
    if (!h || !a) continue;
    h.P++; a.P++;
    h.GF += m.home_score; h.GA += m.away_score;
    a.GF += m.away_score; a.GA += m.home_score;
    if (m.home_score > m.away_score) { h.W++; a.L++; h.Pts += 3; }
    else if (m.away_score > m.home_score) { a.W++; h.L++; a.Pts += 3; }
    else { h.D++; a.D++; h.Pts++; a.Pts++; }
  }

  const ranked = {};
  for (const [g, row] of Object.entries(tables)) {
    const arr = Object.values(row);
    for (const r of arr) r.GD = r.GF - r.GA;
    arr.sort(cmpTeams);
    arr.forEach((r, i) => { r.rank = i + 1; });
    // A group is "decided" once all 6 of its matches have a score.
    const played = data.matches.filter((m) => m.stage === 'group' && m.group === g && hasScore(m)).length;
    ranked[g] = { table: arr, complete: played === 6 };
  }
  return ranked;
}

// FIFA ordering used here: Points, Goal Difference, Goals For, then name as a
// stable final tiebreak. (Head-to-head and fair-play are official deeper
// tiebreaks; they rarely change the top-2/third picture and the live API
// overlay carries the authoritative ordering once matches are played.)
function cmpTeams(a, b) {
  if (b.Pts !== a.Pts) return b.Pts - a.Pts;
  if (b.GD !== a.GD) return b.GD - a.GD;
  if (b.GF !== a.GF) return b.GF - a.GF;
  // final fallback: original draw/seeding order (natural when teams are level,
  // e.g. before any match is played) rather than alphabetical.
  return (a.seed ?? 0) - (b.seed ?? 0);
}

// --- best third-placed teams ----------------------------------------------
// Returns { ranked: [{group, ...row}], qualifiedGroups: Set(letters) } where
// qualifiedGroups is populated only once ALL 12 groups are complete (that is
// when FIFA's allocation runs).
export function computeThirds(standings) {
  const allComplete = Object.values(standings).every((s) => s.complete);
  const thirds = Object.entries(standings)
    .map(([g, s]) => ({ group: g, ...s.table[2] }))
    .filter((r) => r && r.team);
  thirds.sort(cmpTeams);
  const top8 = thirds.slice(0, 8);
  return {
    allComplete,
    ranked: thirds,
    top8,
    qualifiedGroups: allComplete ? new Set(top8.map((t) => t.group)) : null,
  };
}

// --- qualification drama ---------------------------------------------------
// Per group: how many matchdays are done, and a status tag per team derived
// purely from the points math. Tags never over-claim: a team is only "Through"
// once it is mathematically safe in the top 2, only "Out" once it cannot even
// finish 3rd (4th place never advances). Third place is left as a live watch
// because whether a 3rd qualifies depends on the other groups.
export function groupContext(standings, thirds) {
  const out = {};
  for (const [g, s] of Object.entries(standings)) {
    const arr = s.table;
    const matchesPlayed = arr.reduce((n, t) => n + t.P, 0) / 2;
    const currentMd = matchesPlayed === 0 ? 0 : Math.min(3, Math.ceil(matchesPlayed / 2));
    const oMax = (t) => t.Pts + 3 * (3 - t.P);
    const tags = {};

    arr.forEach((t, i) => {
      if (s.complete) {
        if (i < 2) tags[t.team.name] = { label: 'Through', kind: 'through' };
        else if (i === 2) {
          if (thirds.qualifiedGroups) {
            tags[t.team.name] = thirds.qualifiedGroups.has(g)
              ? { label: 'Through', kind: 'through' }
              : { label: 'Out', kind: 'out' };
          } else tags[t.team.name] = { label: 'Best 3rd?', kind: 'watch' };
        } else tags[t.team.name] = { label: 'Out', kind: 'out' };
        return;
      }
      if (matchesPlayed === 0) { tags[t.team.name] = { label: '', kind: '' }; return; }
      const others = arr.filter((x) => x !== t);
      const canOvertake = others.filter((o) => oMax(o) > t.Pts).length; // could finish above me
      const beyondMyReach = others.filter((o) => o.Pts > oMax(t)).length; // already above my ceiling
      if (canOvertake === 0) tags[t.team.name] = { label: '1st', kind: 'through' };
      else if (canOvertake <= 1) tags[t.team.name] = { label: 'Through', kind: 'through' };
      else if (beyondMyReach >= 3) tags[t.team.name] = { label: 'Out', kind: 'out' };
      else if (beyondMyReach >= 2) tags[t.team.name] = { label: '3rd hope', kind: 'watch' };
      else tags[t.team.name] = { label: '', kind: '' };
    });

    // If the group winner is already locked, frame the rest as the 2nd-place race.
    const winnerLocked = arr.some((t) => tags[t.team.name]?.label === '1st');
    if (winnerLocked && !s.complete) {
      arr.forEach((t) => {
        if (tags[t.team.name].kind === '') tags[t.team.name] = { label: 'Plays for 2nd', kind: 'watch' };
      });
    }

    out[g] = { matchesPlayed, currentMd, complete: s.complete, tags };
  }
  return out;
}

// Assign qualifying third-placed groups to the eight R32 "3rd Group X/Y/.."
// slots. Each slot lists the 5 groups it can host; FIFA publishes a lookup
// table keyed on which 8 groups qualify. We instead solve the equivalent
// constraint directly: a perfect bipartite matching of qualified groups to
// slots, where a slot may only take a group from its candidate set. This
// yields a VALID assignment consistent with FIFA's per-slot constraints.
function assignThirds(slots, qualifiedGroups) {
  const groups = [...qualifiedGroups];
  const matchToGroup = {}; // slotIndex -> group letter
  const groupUsed = {};

  const tryAssign = (slotIdx, seen) => {
    for (const g of slots[slotIdx].candidates) {
      if (!qualifiedGroups.has(g) || seen.has(g)) continue;
      seen.add(g);
      if (groupUsed[g] === undefined || tryAssign(groupUsed[g], seen)) {
        groupUsed[g] = slotIdx;
        matchToGroup[slotIdx] = g;
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < slots.length; i++) tryAssign(i, new Set());
  // matchToGroup is complete iff a perfect matching exists (it always does for
  // the real FIFA candidate sets); fall back to leaving slots unresolved.
  return matchToGroup;
}

const THIRD_RE = /^3rd Group ([A-L](?:\/[A-L])*)$/;

// --- full resolution -------------------------------------------------------
// Produces a map id -> { home, away, statusOf } where home/away are either a
// concrete {name, code} or a { placeholder: "Winner Group A" } object.
export function resolve(data, now = Date.now()) {
  const standings = computeStandings(data);
  const thirds = computeThirds(standings);
  const byId = new Map(data.matches.map((m) => [m.id, m]));

  // Pre-solve the third-place slot assignment if the bracket has been drawn.
  const thirdSlots = data.matches
    .filter((m) => m.stage === 'r32')
    .flatMap((m) => ['home_feed', 'away_feed'].map((side) => ({ m, side, feed: m[side] })))
    .filter((x) => THIRD_RE.test(x.feed || ''))
    .map((x) => ({ ...x, candidates: x.feed.match(THIRD_RE)[1].split('/') }));

  let slotGroup = {}; // "id:side" -> group letter
  if (thirds.qualifiedGroups) {
    const assignment = assignThirds(thirdSlots, thirds.qualifiedGroups);
    thirdSlots.forEach((slot, i) => {
      const g = assignment[i];
      if (g) slotGroup[`${slot.m.id}:${slot.side}`] = g;
    });
  }

  const cache = new Map();

  function resolveFeed(feed, ownerId, side) {
    if (!feed) return { placeholder: 'TBD' };

    let mm = feed.match(/^Winner Group ([A-L])$/);
    if (mm) {
      const s = standings[mm[1]];
      return s.complete ? { ...s.table[0].team } : { placeholder: feed };
    }
    mm = feed.match(/^Runner-up Group ([A-L])$/);
    if (mm) {
      const s = standings[mm[1]];
      return s.complete ? { ...s.table[1].team } : { placeholder: feed };
    }
    mm = feed.match(/^Winner Match (\d+)$/);
    if (mm) return resolveOutcome(+mm[1], 'winner', feed);
    mm = feed.match(/^Loser Match (\d+)$/);
    if (mm) return resolveOutcome(+mm[1], 'loser', feed);

    if (THIRD_RE.test(feed)) {
      const g = slotGroup[`${ownerId}:${side}`];
      if (g && standings[g] && standings[g].table[2]) {
        return { ...standings[g].table[2].team };
      }
      return { placeholder: feed };
    }
    return { placeholder: feed };
  }

  function resolveOutcome(matchId, which, feed) {
    const m = byId.get(matchId);
    if (!m) return { placeholder: feed };
    const { winner, loser } = outcome(m);
    const pick = which === 'winner' ? winner : loser;
    if (!pick) return { placeholder: feed };
    const slot = pick === 'home' ? 'home' : 'away';
    const team = sideTeam(m, slot);
    return team ? { ...team } : { placeholder: feed };
  }

  function sideTeam(m, slot) {
    if (m.stage === 'group') return m[slot];
    const key = `${m.id}:${slot}`;
    if (cache.has(key)) return cache.get(key);
    cache.set(key, { placeholder: 'TBD' }); // guard against cycles
    const feed = slot === 'home' ? m.home_feed : m.away_feed;
    const r = resolveFeed(feed, m.id, slot === 'home' ? 'home_feed' : 'away_feed');
    const out = r.placeholder ? null : r;
    cache.set(key, out);
    return out;
  }

  const out = new Map();
  for (const m of data.matches) {
    const home = m.stage === 'group'
      ? { ...m.home }
      : resolveFeed(m.home_feed, m.id, 'home_feed');
    const away = m.stage === 'group'
      ? { ...m.away }
      : resolveFeed(m.away_feed, m.id, 'away_feed');
    out.set(m.id, { home, away, status: displayStatus(m, now) });
  }

  return { standings, thirds, resolved: out };
}
