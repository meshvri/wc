// match.js — deep-linkable Match Detail (match.html?m=<fifa_id>).
// Timeline-led single scroll: sticky score hero → goals → timeline (narrative
// spine) → line-ups (formation) → stats → info. Reads our committed
// tournament.json for the fixture + team codes (via the engine), then overlays
// FIFA's per-match detail + timeline endpoints. Everything degrades to the
// committed data; the page never blanks.
import { resolve } from './engine.js';

const COMP = '17', SEASON = '285023';
const TZ = 'Asia/Riyadh';
const $ = (s, r = document) => r.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const loc = (a) => (Array.isArray(a) ? (a[0] && a[0].Description) || '' : (a || ''));
const flagURL = (code) => `https://flagcdn.com/${code}.svg`;
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const numOr0 = (v) => (Number.isFinite(v) ? v : 0);
const POS = { 0: 'GK', 1: 'DEF', 2: 'MID', 3: 'FWD' };

const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const ROUND = { r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-final', sf: 'Semi-final', third: 'Third-place play-off', final: 'Final' };

let DATA, RES, MATCH, DETAIL = null, TIMELINE = null;
const nameToCode = new Map();
let pollTimer = null, backoff = 0;

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  const fid = new URLSearchParams(location.search).get('m');
  try {
    const r = await fetch('data/tournament.json', { cache: 'no-store' });
    DATA = await r.json();
  } catch (e) { return fatal('Could not load the schedule. Please go back and retry.'); }
  RES = resolve(DATA, Date.now());
  for (const teams of Object.values(DATA.groups)) for (const t of teams) nameToCode.set(norm(t.name), t.code);
  MATCH = DATA.matches.find((m) => String(m.fifa_id) === String(fid));
  if (!MATCH) return fatal('Match not found.');

  await loadFifa();
  render();
  setupLive();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
}

async function loadFifa() {
  if (!MATCH.fifa_id || !MATCH.fifa_stage) return;
  const base = `https://api.fifa.com/api/v3`;
  const dUrl = `${base}/live/football/${COMP}/${SEASON}/${MATCH.fifa_stage}/${MATCH.fifa_id}?language=en`;
  const tUrl = `${base}/timelines/${COMP}/${SEASON}/${MATCH.fifa_stage}/${MATCH.fifa_id}?language=en`;
  try {
    const [d, t] = await Promise.all([
      fetch(dUrl, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(tUrl, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (d) DETAIL = d;
    if (t) TIMELINE = t;
    backoff = 0;
  } catch (e) { backoff = Math.min(5, backoff + 1); } // keep last-known
}

// ── derived match state ──────────────────────────────────────────────────────
function side(which) {
  const r = RES.resolved.get(MATCH.id)[which];
  const fd = DETAIL && (which === 'home' ? DETAIL.HomeTeam : DETAIL.AwayTeam);
  const name = (fd && loc(fd.TeamName)) || (r && !r.placeholder && r.name) || (r && r.placeholder) || 'TBD';
  const code = (r && r.code) || nameToCode.get(norm(name)) || null;
  return { name, code, fd, placeholder: !code };
}
function state() {
  // Base status on OUR committed data (the cron classifies it correctly — FIFA's
  // detail returns Score 0, not null, for unplayed matches). FIFA only upgrades
  // to live + supplies the minute.
  const fdLive = DETAIL && DETAIL.MatchStatus === 3;
  let status;
  if (fdLive || MATCH.status === 'live') status = 'live';
  else if (MATCH.status === 'finished'
    || (Number.isFinite(MATCH.home_score) && Number.isFinite(MATCH.away_score))) status = 'finished';
  else status = 'upcoming';
  const hs = status === 'upcoming' ? NaN : numScore('home', status);
  const as = status === 'upcoming' ? NaN : numScore('away', status);
  const minute = fdLive ? loc(DETAIL.MatchTime) || DETAIL.MatchTime || '' : '';
  return { status, minute, hs, as };
}
function numScore(which, status) {
  if (status === 'live') { // live: FIFA is fresher than the committed file
    const fd = DETAIL && (which === 'home' ? DETAIL.HomeTeam : DETAIL.AwayTeam);
    if (fd && Number.isFinite(Number(fd.Score))) return Number(fd.Score);
  }
  const v = which === 'home' ? MATCH.home_score : MATCH.away_score;
  return Number.isFinite(v) ? v : NaN;
}
const penOf = (which) => {
  const fd = DETAIL && (which === 'home' ? DETAIL.HomeTeam : DETAIL.AwayTeam);
  const fp = which === 'home' ? DETAIL && DETAIL.HomeTeamPenaltyScore : DETAIL && DETAIL.AwayTeamPenaltyScore;
  if (Number.isFinite(Number(fp))) return Number(fp);
  const v = which === 'home' ? MATCH.home_pens : MATCH.away_pens;
  return Number.isFinite(v) ? v : null;
};

// ── render ───────────────────────────────────────────────────────────────────
function render() {
  const root = $('#md');
  root.innerHTML = '';
  const st = state();
  const H = side('home'), A = side('away');

  root.appendChild(renderHero(H, A, st));
  const goals = renderGoals(H, A);
  if (goals) root.appendChild(goals);
  const cards = renderCards(H, A);
  if (cards) root.appendChild(cards);
  const lineups = renderLineups(H, A, st);
  root.appendChild(lineups);
  const stats = renderStats(H, A);
  if (stats) root.appendChild(stats);
  root.appendChild(renderInfo(st));
  root.appendChild(el('p', 'md-foot', DETAIL ? 'Live data: FIFA' : 'Showing fixture data'));
}

function teamBlock(s, cls) {
  const flag = s.code
    ? `<img class="md-flag" src="${flagURL(s.code)}" alt="" width="46" height="34">`
    : `<span class="md-flag tbd">?</span>`;
  return `<div class="md-team ${cls}">${flag}<span class="md-tname">${s.name}</span></div>`;
}

function renderHero(H, A, st) {
  const hero = el('header', 'md-hero');
  hero.dataset.status = st.status;
  const back = el('button', 'md-back', '&#8592;');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to schedule');
  back.addEventListener('click', () => { if (history.length > 1) history.back(); else location.href = './'; });
  hero.appendChild(back);

  const stage = MATCH.stage === 'group'
    ? `Group ${MATCH.group} · Match ${MATCH.id}`
    : `${ROUND[MATCH.stage] || ''} · Match ${MATCH.id}`;
  hero.appendChild(el('div', 'md-stage', stage));

  let mid;
  if (st.status === 'upcoming') {
    mid = `<div class="md-vs">vs</div><div class="md-chip up">${kickoffChip()}</div>`;
  } else {
    const pens = hasShootout() ? `<div class="md-pens">pens ${penOf('home')}–${penOf('away')}</div>` : '';
    const chip = st.status === 'live'
      ? `<div class="md-chip live"><span class="dot"></span>LIVE${st.minute ? ` ${st.minute}` : ''}</div>`
      : `<div class="md-chip ft">${resultWord()}</div>`;
    mid = `<div class="md-score tnum">${numOr0(st.hs)}<span class="md-dash">–</span>${numOr0(st.as)}</div>${pens}${chip}`;
  }

  hero.appendChild(el('div', 'md-match', `${teamBlock(H, 'h')}<div class="md-mid">${mid}</div>${teamBlock(A, 'a')}`));
  hero.appendChild(el('div', 'md-when', `${fmtDay.format(new Date(MATCH.kickoff_utc))} · ${fmtTime.format(new Date(MATCH.kickoff_utc))} Riyadh`));
  const place = [MATCH.venue, MATCH.city].filter(Boolean).join(' · ');
  if (place) hero.appendChild(el('div', 'md-where', place));
  return hero;
}
function kickoffChip() {
  const ms = Date.parse(MATCH.kickoff_utc) - Date.now();
  if (ms <= 0) return 'Kicking off';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}
function hasShootout() {
  if (MATCH.stage === 'group') return false;
  const h = penOf('home'), a = penOf('away');
  return Number.isFinite(h) && Number.isFinite(a) && (h + a) > 0;
}
function resultWord() {
  if (hasShootout()) return 'FT · pens';
  if (DETAIL && /EXTRA/i.test(DETAIL.ResultType || '')) return 'AET';
  return 'Full time';
}

// goals summary (from FIFA detail Goals, names resolved via the lineup)
function playerMap(teamFd) {
  const map = new Map();
  for (const p of (teamFd && teamFd.Players) || []) map.set(String(p.IdPlayer), loc(p.PlayerName) || loc(p.ShortName));
  return map;
}
function renderGoals(H, A) {
  if (!DETAIL) return null;
  const rows = (which, fd) => {
    const pm = playerMap(fd);
    return ((fd && fd.Goals) || []).map((g) => {
      const sc = pm.get(String(g.IdPlayer)) || 'Goal';
      const min = loc(g.Minute) || g.Minute || '';
      const og = g.Type === 6 || g.Type === 7 ? ' (OG)' : '';
      const pen = g.Type === 4 || g.Type === 5 ? ' (pen)' : '';
      return `<li>${prettyName(sc)}${og}${pen} <span class="g-min">${min}</span></li>`;
    });
  };
  const h = rows('home', H.fd), a = rows('away', A.fd);
  if (!h.length && !a.length) return null;
  const ball = '<span class="g-ball">⚽</span>';
  const sec = el('section', 'md-goals');
  // only show the ball for a side that actually scored
  sec.innerHTML = `<div class="g-col h">${h.length ? ball : ''}<ul>${h.join('')}</ul></div>`
    + `<div class="g-col a"><ul>${a.join('')}</ul>${a.length ? ball : ''}</div>`;
  return sec;
}
const prettyName = (n) => n.replace(/\b([A-ZÀ-Ý]{2,})\b/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());

// cards — concise booking summary (no play-by-play commentary)
function renderCards(H, A) {
  if (!DETAIL) return null;
  const rows = (fd) => {
    const pm = playerMap(fd);
    return ((fd && fd.Bookings) || []).map((b) => {
      const red = b.Card === 2 || b.Card === 3 || b.Card === 5;
      const min = loc(b.Minute) || b.Minute || '';
      return `<li><i class="card ${red ? 'red' : 'yellow'}"></i>${prettyName(pm.get(String(b.IdPlayer)) || '')} <span class="g-min">${min}</span></li>`;
    });
  };
  const h = rows(H.fd), a = rows(A.fd);
  if (!h.length && !a.length) return null;
  const sec = el('section', 'md-goals md-cards');
  sec.innerHTML = `<div class="g-col h"><ul>${h.join('')}</ul></div><div class="g-col a"><ul>${a.join('')}</ul></div>`;
  return sec;
}

// line-ups — Position-grouped formation pitch (LineupX/Y are not provided)
let lineupSide = 'home';
function renderLineups(H, A, st) {
  const sec = el('section', 'md-section md-lineups');
  const head = sectionHead('Line-ups');
  const toggle = el('div', 'md-toggle');
  for (const w of ['home', 'away']) {
    const b = el('button', `mt-btn${w === lineupSide ? ' on' : ''}`, w === 'home' ? H.name : A.name);
    b.type = 'button';
    b.addEventListener('click', () => { lineupSide = w; render(); });
    toggle.appendChild(b);
  }
  head.appendChild(toggle);
  sec.appendChild(head);

  const s = lineupSide === 'home' ? H : A;
  const fd = s.fd;
  const players = (fd && fd.Players) || [];
  const starters = players.filter((p) => p.Status === 1);
  if (!starters.length) {
    sec.appendChild(el('p', 'md-empty', st.status === 'upcoming'
      ? 'Line-ups are usually announced about an hour before kick-off.'
      : 'Line-ups not available for this match.'));
    return sec;
  }
  const pitch = el('div', 'pitch');
  for (const pos of [3, 2, 1, 0]) { // FWD at top (attacking), GK at the back
    const row = el('div', 'pitch-row');
    starters.filter((p) => p.Position === pos)
      .sort((a, b) => (a.ShirtNumber || 0) - (b.ShirtNumber || 0))
      .forEach((p) => row.appendChild(playerChip(p)));
    if (row.children.length) pitch.appendChild(row);
  }
  sec.appendChild(pitch);

  const bench = players.filter((p) => p.Status === 2);
  if (bench.length) {
    sec.appendChild(el('div', 'md-subhead', 'Substitutes'));
    const ul = el('ul', 'bench');
    bench.sort((a, b) => (a.ShirtNumber || 0) - (b.ShirtNumber || 0))
      .forEach((p) => ul.appendChild(el('li', null, `<span class="b-num tnum">${p.ShirtNumber || ''}</span> ${prettyName(loc(p.PlayerName))}`)));
    sec.appendChild(ul);
  }
  const coach = fd.Coaches && fd.Coaches[0];
  if (coach) sec.appendChild(el('div', 'md-coach', `Coach · ${prettyName(loc(coach.Name))}`));
  return sec;
}
function playerChip(p) {
  const chip = el('div', 'p-chip');
  chip.innerHTML = `<span class="p-num tnum">${p.ShirtNumber || ''}</span>`
    + `<span class="p-name">${prettyName(loc(p.ShortName) || loc(p.PlayerName))}${p.Captain ? ' <b class="cap">C</b>' : ''}</span>`;
  return chip;
}

// stats — possession (when present) + shots/corners/fouls from the timeline
function renderStats(H, A) {
  if (!DETAIL) return null;
  const evs = (TIMELINE && TIMELINE.Event) || [];
  const homeId = String(DETAIL.HomeTeam && DETAIL.HomeTeam.IdTeam);
  const count = (type) => {
    let h = 0, a = 0;
    for (const e of evs) if (e.Type === type) (String(e.IdTeam) === homeId ? h++ : a++);
    return [h, a];
  };
  const rows = [];
  const poss = DETAIL.BallPossession;
  if (poss && Number.isFinite(Number(poss.Intervals ? null : poss.OverallHome)) ) {
    rows.push(['Possession', Math.round(poss.OverallHome), Math.round(poss.OverallAway), '%']);
  }
  const [sh, sa] = count(12); if (sh + sa) rows.push(['Shots', sh, sa]);
  const [ch, ca] = count(16); if (ch + ca) rows.push(['Corners', ch, ca]);
  const [fh, fa] = count(18); if (fh + fa) rows.push(['Fouls', fh, fa]);
  if (!rows.length) return null;

  const sec = el('section', 'md-section md-stats');
  sec.appendChild(sectionHead('Match stats'));
  for (const [label, h, a, suf] of rows) {
    const tot = (h + a) || 1;
    const row = el('div', 'stat');
    row.innerHTML = `<span class="s-h tnum">${h}${suf || ''}</span>`
      + `<span class="s-bar"><i style="width:${(h / tot) * 100}%"></i></span>`
      + `<span class="s-label">${label}</span>`
      + `<span class="s-bar a"><i style="width:${(a / tot) * 100}%"></i></span>`
      + `<span class="s-a tnum">${a}${suf || ''}</span>`;
    sec.appendChild(row);
  }
  return sec;
}

// info — stadium / referee / attendance / weather (skip nulls)
function renderInfo(st) {
  const sec = el('section', 'md-section md-info');
  sec.appendChild(sectionHead('Match info'));
  const items = [];
  const stadium = DETAIL && DETAIL.Stadium && loc(DETAIL.Stadium.Name);
  items.push(['Venue', [stadium || MATCH.venue, MATCH.city].filter(Boolean).join(', ')]);
  const ref = DETAIL && DETAIL.Officials && DETAIL.Officials[0];
  if (ref) items.push(['Referee', prettyName(loc(ref.Name) || loc(ref.NameShort))]);
  if (DETAIL && Number.isFinite(Number(DETAIL.Attendance)) && Number(DETAIL.Attendance) > 0) {
    items.push(['Attendance', Number(DETAIL.Attendance).toLocaleString('en-US')]);
  }
  const w = DETAIL && DETAIL.Weather;
  if (w && (loc(w.TypeLocalized) || w.Temperature != null)) {
    items.push(['Weather', [loc(w.TypeLocalized), w.Temperature != null ? `${w.Temperature}°C` : ''].filter(Boolean).join(', ')]);
  }
  const dl = el('dl', 'info-grid');
  for (const [k, v] of items) if (v) dl.innerHTML += `<dt>${k}</dt><dd>${v}</dd>`;
  sec.appendChild(dl);
  return sec;
}

function sectionHead(t) { return el('h2', 'md-h', t); }
function fatal(msg) {
  $('#md').innerHTML = `<div class="md-fatal"><p>${msg}</p><a class="md-home" href="./">← Back to schedule</a></div>`;
}

// ── live refresh (reuse the ~45s cadence, pause when hidden) ─────────────────
function setupLive() { schedule(45000); }
function schedule(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(tick, ms); }
async function tick() {
  const live = state().status === 'live';
  if (document.visibilityState !== 'visible' || !live) { schedule(45000); return; }
  await loadFifa();
  // preserve scroll across the re-render
  const y = window.scrollY;
  render();
  window.scrollTo({ top: y, behavior: 'auto' });
  schedule(45000 * (1 + backoff));
}

boot();
