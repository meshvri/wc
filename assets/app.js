// app.js — rendering + interaction. iPhone-first. All clock display goes
// through the Asia/Riyadh timezone API (never a hardcoded +3 offset).
import { resolve, hasScore, groupContext, resultLabel } from './engine.js';

const TZ = 'Asia/Riyadh';
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const flagURL = (code) => `https://flagcdn.com/${code}.svg`;

const ROUND = {
  r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-finals',
  sf: 'Semi-finals', third: 'Third-place play-off', final: 'Final',
};
const ROUND_SHORT = { r32: 'R32', r16: 'R16', qf: 'QF', sf: 'SF', third: '3RD', final: 'FINAL' };
const KO_ORDER = ['r32', 'r16', 'qf', 'sf', 'third', 'final'];

// --- Riyadh time helpers ---------------------------------------------------
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const fmtParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
});
const fmtDayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fmtChip = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' });

// Split a Riyadh 12-hour time into the "h:mm" body and the "AM/PM" suffix so
// the row can render the suffix smaller (scoreboard style) and never overflow.
function timeParts(iso) {
  const parts = fmtTime.formatToParts(new Date(iso));
  const ap = parts.find((p) => p.type === 'dayPeriod')?.value || '';
  const hm = parts.filter((p) => ['hour', 'minute', 'literal'].includes(p.type))
    .map((p) => p.value).join('').trim();
  return { hm, ap };
}

function riyadhParts(iso) {
  const map = {};
  for (const p of fmtParts.formatToParts(new Date(iso))) map[p.type] = p.value;
  return map; // {weekday, day, month, year}
}
// Stable per-day key in Riyadh local calendar.
const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (iso) => fmtKey.format(new Date(iso));
function riyadhHour(iso) {
  return +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(iso)).slice(0, 2);
}
const prevWeekday = (iso) => {
  const d = new Date(new Date(iso).getTime() - 864e5);
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' }).format(d);
};

function winnerSide(m) {
  if (!hasScore(m)) return null;
  if (m.home_score > m.away_score) return 'home';
  if (m.away_score > m.home_score) return 'away';
  return m.winner || null;
}

// --- live overlay (FIFA client poll) ---------------------------------------
// LIVE_OV is a render-time overlay ONLY: id -> { home, away, min, status }. It
// never touches committed DATA or the engine, so it can never advance the
// bracket. It freshens the score/minute of in-progress matches AND bridges the
// gap for a JUST-finished match until the (slower) cron commits the final — so
// the page never shows a stale "1-0 LIVE" after FIFA already says "2-0 FT".
let LIVE_OV = new Map();
const liveOv = (m) => LIVE_OV.get(m.id) || null;
const numOr0 = (v) => (Number.isFinite(v) ? v : 0);
// display status / score / minute, preferring the overlay
const dStatus = (m) => (liveOv(m) ? liveOv(m).status : RES.resolved.get(m.id).status);
function dScore(m, which) {
  const ov = liveOv(m);
  if (ov) return which === 'home' ? ov.home : ov.away;
  return which === 'home' ? m.home_score : m.away_score;
}
const dMinute = (m) => { const ov = liveOv(m); return ov && ov.status === 'live' ? ov.min : ''; };
// only show a winner once finished — computed from the overlay score when present
function dWinSide(m) {
  const ov = liveOv(m);
  if (ov) {
    if (ov.status !== 'finished') return null;
    if (ov.home > ov.away) return 'home';
    if (ov.away > ov.home) return 'away';
    return m.winner || null; // level: penalty winner from committed data
  }
  return dStatus(m) === 'finished' ? winnerSide(m) : null;
}

const STAR = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">'
  + '<path d="M12 3.2l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.9l-5.2 2.74.99-5.79-4.21-4.1 5.82-.85z"/></svg>';

// ---------------------------------------------------------------------------
let DATA, RES, NOW, GCTX;
let CODE_INDEX = new Map();      // code -> {name, code, group}
let MATCHDAY = new Map();        // group match id -> matchday number (1-3)
let MATCH_IDS = new Set();       // all our match ids (== FIFA MatchNumbers)
const todayKey = () => fmtKey.format(new Date(NOW));

// --- pinned teams (localStorage) -------------------------------------------
const PIN_KEY = 'wc.pinned.v1';
let PINS = loadPins();
function loadPins() {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return new Set(['sa']); // Saudi Arabia pinned by default
}
function savePins() {
  try { localStorage.setItem(PIN_KEY, JSON.stringify([...PINS])); } catch (e) { /* ignore */ }
}
const isPinned = (code) => !!code && PINS.has(code);
function togglePin(code) {
  if (!code) return;
  if (PINS.has(code)) PINS.delete(code); else PINS.add(code);
  savePins();
  applyPins();
}

async function boot() {
  try {
    const res = await fetch('data/tournament.json', { cache: 'no-store' });
    DATA = await res.json();
  } catch (e) {
    $('#views').innerHTML = '<p class="empty">Could not load the schedule. Please refresh.</p>';
    return;
  }
  NOW = Date.now();
  RES = resolve(DATA, NOW);
  GCTX = groupContext(RES.standings, RES.thirds);
  buildIndexes();

  renderHosts();
  renderMatches();
  renderGroups();
  renderBracket();
  renderUpdated();
  wireTabs();
  applyPins();
  setupNowPill();

  syncBarHeight();
  window.addEventListener('resize', syncBarHeight);

  // jump the matches view to today (or the next match day)
  requestAnimationFrame(scrollToToday);

  setupLiveRefresh();
  setupFifaLive();
  registerServiceWorker();
}

// Re-render everything from current DATA while preserving scroll + active tab.
function rerenderAll() {
  RES = resolve(DATA, NOW);
  GCTX = groupContext(RES.standings, RES.thirds);
  const y = window.scrollY;
  const active = document.querySelector('.tab[aria-selected="true"]')?.dataset.view || 'matches';
  renderMatches();
  renderGroups();
  renderBracket();
  renderUpdated();
  selectTab(active);
  applyPins();
  updateNowPill();
  window.scrollTo({ top: y, behavior: 'auto' });
}

function buildIndexes() {
  CODE_INDEX = new Map();
  for (const [g, teams] of Object.entries(DATA.groups)) {
    for (const t of teams) CODE_INDEX.set(t.code, { ...t, group: g });
  }
  // matchday per group fixture (2 matches per matchday, in kickoff order)
  MATCHDAY = new Map();
  for (const g of Object.keys(DATA.groups)) {
    DATA.matches.filter((m) => m.stage === 'group' && m.group === g)
      .sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc))
      .forEach((m, i) => MATCHDAY.set(m.id, Math.floor(i / 2) + 1));
  }
  MATCH_IDS = new Set(DATA.matches.map((m) => m.id));
}

// resolved sides for a match (group teams are concrete; knockouts resolved)
function sideCode(m, which) {
  const r = RES.resolved.get(m.id);
  const s = which === 'home' ? r.home : r.away;
  return s && !s.placeholder ? s.code : null;
}
// every match (in kickoff order) a given team code appears in, resolved
function matchesForCode(code) {
  return [...DATA.matches]
    .sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc))
    .map((m) => {
      const r = RES.resolved.get(m.id);
      const side = r.home?.code === code ? 'home' : r.away?.code === code ? 'away' : null;
      return side ? { m, side } : null;
    })
    .filter(Boolean);
}

// The sticky day headers offset by the real bar height (safe-area varies).
function syncBarHeight() {
  const bar = document.querySelector('.bar');
  if (bar) document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`);
}

function renderHosts() {
  $('#hosts').textContent = DATA.meta.subtitle || '';
}

// === MATCHES ===============================================================
function renderMatches() {
  const view = $('#view-matches');
  const matches = [...DATA.matches].sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc));

  // next upcoming match (for the NEXT pill)
  const nextId = matches.find((m) => RES.resolved.get(m.id).status === 'upcoming' && Date.parse(m.kickoff_utc) >= NOW)?.id;

  // group by Riyadh day
  const days = new Map();
  for (const m of matches) {
    const k = dayKey(m.kickoff_utc);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(m);
  }

  // day strip
  const strip = $('#daystrip');
  strip.innerHTML = '';
  for (const [k, ms] of days) {
    const chip = el('button', 'chip');
    const parts = fmtChip.formatToParts(new Date(ms[0].kickoff_utc));
    const map = {}; for (const p of parts) map[p.type] = p.value;
    chip.innerHTML = `<span class="dow">${map.weekday}</span>${map.day}`;
    chip.dataset.target = k;
    if (k === todayKey()) chip.dataset.today = 'true';
    chip.addEventListener('click', () => {
      const sec = view.querySelector(`[data-day="${CSS.escape(k)}"]`);
      sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    strip.appendChild(chip);
  }

  // sections
  view.innerHTML = '';
  const pinStrip = renderPinStrip();
  if (pinStrip) view.appendChild(pinStrip);
  for (const [k, ms] of days) {
    const sec = el('section');
    sec.dataset.day = k;

    const hdr = el('div', 'dayhdr');
    if (k === todayKey()) hdr.dataset.today = 'true';
    const lbl = fmtDayLabel.format(new Date(ms[0].kickoff_utc));
    hdr.appendChild(el('h2', null, lbl));
    hdr.appendChild(el('span', 'tz', 'Riyadh'));
    hdr.appendChild(el('span', 'count', `${ms.length} ${ms.length === 1 ? 'match' : 'matches'}`));
    sec.appendChild(hdr);

    for (const m of ms) sec.appendChild(matchRow(m, m.id === nextId));
    view.appendChild(sec);
  }

  observeDays(view, strip);
}

function matchRow(m, isNext) {
  const r = RES.resolved.get(m.id);
  const row = el('div', 'match');
  row.dataset.stage = m.stage;
  row.id = `m${m.id}`;
  if (r.home?.code) row.dataset.homeCode = r.home.code;
  if (r.away?.code) row.dataset.awayCode = r.away.code;

  // left: kickoff time + late badge
  const ko = el('div', 'kotime');
  const tp = timeParts(m.kickoff_utc);
  ko.appendChild(el('div', 't tnum', `${tp.hm}<span class="ap">${tp.ap}</span>`));
  const stageMeta = m.stage === 'group'
    ? `${m.group} · MD${MATCHDAY.get(m.id)}`
    : ROUND_SHORT[m.stage];
  ko.appendChild(el('div', 'meta', stageMeta));
  const h = riyadhHour(m.kickoff_utc);
  if (h < 6) {
    ko.appendChild(el('span', 'late', `🌙 ${prevWeekday(m.kickoff_utc)} night`));
  }
  row.appendChild(ko);

  const status = dStatus(m);
  row.dataset.status = status;

  // middle: teams
  const winSide = dWinSide(m);
  const showScore = status === 'live' || status === 'finished' || status === 'pending';
  const teams = el('div', 'teams');
  teams.appendChild(teamLine(r.home, m, 'home', winSide, showScore));
  teams.appendChild(teamLine(r.away, m, 'away', winSide, showScore));
  row.appendChild(teams);

  // right: status rail
  const rail = el('div', 'rail');
  if (status === 'live') {
    const min = dMinute(m);
    rail.appendChild(el('span', 'pill live', `<span class="dot"></span>LIVE${min ? ` ${min}` : ''}`));
  } else if (status === 'pending') {
    rail.appendChild(el('span', 'pill pending', 'RESULT PENDING'));
  } else if (status === 'finished') {
    rail.appendChild(el('span', 'pill ft', m.stage === 'group' ? 'FT' : resultLabel(m)));
  } else if (isNext) {
    rail.appendChild(el('span', 'pill grp', 'NEXT'));
  }
  rail.appendChild(el('span', 'venue', m.city || m.venue || ''));
  row.appendChild(rail);

  if (m.fifa_id) {
    row.classList.add('tappable');
    row.addEventListener('click', () => { location.href = `match.html?m=${m.fifa_id}`; });
  }
  return row;
}

function teamLine(side, m, which, winSide, showScore) {
  const line = el('div', 'team');
  const isPlaceholder = !!side.placeholder;
  if (winSide) {
    line.classList.add(which === winSide ? 'win' : 'lose');
  }
  if (isPlaceholder) {
    line.appendChild(el('span', 'flag tbd', '?'));
    line.appendChild(el('span', 'name ph', side.placeholder));
  } else {
    line.dataset.team = side.code;
    const img = el('img', 'flag');
    img.src = flagURL(side.code);
    img.alt = side.name;
    img.loading = 'lazy';
    img.width = 26; img.height = 19;
    line.appendChild(img);
    line.appendChild(el('span', 'name', side.name));
  }
  // a live or finished match always shows a number (never "null"): a kicked-off
  // match with no goals yet reads 0, and the live overlay supplies the rest.
  if (showScore && !isPlaceholder) {
    const pen = which === 'home' ? m.home_pens : m.away_pens;
    const sc = el('span', 'sc tnum', String(numOr0(dScore(m, which))));
    if (Number.isFinite(pen)) sc.appendChild(el('span', 'pens', `(${pen})`));
    line.appendChild(sc);
  }
  if (!isPlaceholder) line.appendChild(starBtn(side.code, side.name));
  return line;
}

// a tap-to-pin star; stops propagation so it never triggers a row action
function starBtn(code, name) {
  const b = el('button', 'star', STAR);
  b.dataset.team = code;
  b.type = 'button';
  b.setAttribute('aria-label', `Follow ${name}`);
  b.addEventListener('click', (e) => { e.stopPropagation(); togglePin(code); });
  return b;
}

// === GROUPS ================================================================
function renderGroups() {
  const view = $('#view-groups');
  view.innerHTML = '';
  const grid = el('div', 'grpgrid');

  for (const [g, s] of Object.entries(RES.standings)) {
    const ctx = GCTX[g];
    const card = el('div', 'gcard');
    const md = ctx.complete ? 'Final standings'
      : ctx.currentMd === 0 ? 'Not started'
        : `Matchday ${ctx.currentMd} of 3`;
    card.appendChild(el('h3', null, `Group <span>${g}</span><em class="md">${md}</em>`));

    const head = el('div', 'strow head');
    head.innerHTML = '<span></span><span class="pos">#</span><span></span><span class="nm">Team</span>'
      + '<span class="v">P</span><span class="v">GD</span><span class="pts">Pts</span>';
    card.appendChild(head);

    s.table.forEach((t, i) => {
      const adv = i < 2 ? '1' : (i === 2 ? '3' : '');
      const tag = ctx.tags[t.team.name] || { label: '', kind: '' };
      const r = el('div', 'strow');
      r.dataset.team = t.team.code;
      if (adv) r.dataset.adv = adv;
      const img = `<img class="flag" src="${flagURL(t.team.code)}" alt="" loading="lazy" width="22" height="16">`;
      const tagHtml = tag.label ? `<span class="qtag" data-kind="${tag.kind}">${tag.label}</span>` : '';
      r.innerHTML = `<span class="starcell"></span><span class="pos">${i + 1}</span>${img}`
        + `<span class="nmwrap"><span class="nm">${t.team.name}</span>${tagHtml}</span>`
        + `<span class="v tnum">${t.P}</span>`
        + `<span class="v tnum">${t.GD > 0 ? '+' : ''}${t.GD}</span><span class="pts tnum">${t.Pts}</span>`;
      r.querySelector('.starcell').appendChild(starBtn(t.team.code, t.team.name));
      card.appendChild(r);
    });
    grid.appendChild(card);
  }
  view.appendChild(grid);

  const key = el('div', 'adv-key');
  key.innerHTML = '<span><i class="q"></i>Top 2 advance</span><span><i class="t"></i>3rd → 8 best qualify</span>'
    + '<span><i class="star-i">' + STAR + '</i>Tap to follow</span>';
  view.appendChild(key);
  view.appendChild(el('p', 'hint',
    'Standings and qualification update automatically as results land. Order: points, then goal difference, then goals scored.'));
}

// === BRACKET ===============================================================
function renderBracket() {
  const view = $('#view-bracket');
  view.innerHTML = '';
  const wrap = el('div', 'bracket');
  const inner = el('div', 'bracket-inner');

  for (const stage of KO_ORDER) {
    if (stage === 'third') continue; // shown beneath, not as a column
    const col = el('div', 'bcol');
    col.appendChild(el('div', 'lbl', ROUND[stage]));
    const body = el('div', 'bcol-body');
    DATA.matches.filter((m) => m.stage === stage)
      .sort((a, b) => a.id - b.id)
      .forEach((m) => body.appendChild(tieCard(m)));
    col.appendChild(body);
    inner.appendChild(col);
  }
  wrap.appendChild(inner);
  view.appendChild(wrap);

  // champion + third place beneath
  const final = DATA.matches.find((m) => m.stage === 'final');
  const champSide = winnerSide(final);
  const champ = champSide ? RES.resolved.get(final.id)[champSide] : null;
  const banner = el('div', 'champ-banner');
  if (champ && !champ.placeholder) {
    banner.innerHTML = `🏆 World Champions<span class="who"><img class="flag" src="${flagURL(champ.code)}" `
      + `style="width:24px;height:18px;vertical-align:-3px;margin-right:8px" alt="">${champ.name}</span>`;
  } else {
    banner.innerHTML = 'The trophy is lifted on 19 July at MetLife Stadium.';
  }
  view.appendChild(banner);

  const third = DATA.matches.find((m) => m.stage === 'third');
  const t3 = el('div'); t3.style.marginTop = '22px';
  t3.appendChild(el('div', 'roundhdr', '<h2 style="font-size:13px">Third-place play-off</h2><span class="ln"></span>'));
  const holder = el('div'); holder.style.maxWidth = '260px';
  holder.appendChild(tieCard(third));
  t3.appendChild(holder);
  view.appendChild(t3);

  view.appendChild(el('p', 'hint',
    'Swipe sideways to follow the bracket. Slots fill in automatically the moment a feeding match finishes.'));
}

function tieCard(m) {
  const r = RES.resolved.get(m.id);
  const status = dStatus(m);
  const card = el('div', 'tie');
  card.dataset.status = status;
  if (m.stage === 'final') card.classList.add('champ');

  const head = el('div', 'mno');
  const right = status === 'pending'
    ? '<b class="pend">Result pending</b>'
    : status === 'live'
      ? `<b class="pend" style="color:var(--live)">LIVE${dMinute(m) ? ` ${dMinute(m)}` : ''}</b>`
      : `${fmtChip.format(new Date(m.kickoff_utc))} · ${fmtTime.format(new Date(m.kickoff_utc))}`;
  head.innerHTML = `<span>Match ${m.id}</span><span>${right}</span>`;
  card.appendChild(head);

  const winSide = dWinSide(m);
  const showScore = status === 'live' || status === 'finished' || status === 'pending';
  card.appendChild(tieSide(r.home, m, 'home', winSide, showScore));
  card.appendChild(tieSide(r.away, m, 'away', winSide, showScore));
  if (m.fifa_id) {
    card.classList.add('tappable');
    card.addEventListener('click', () => { location.href = `match.html?m=${m.fifa_id}`; });
  }
  return card;
}

function tieSide(side, m, which, winSide, showScore) {
  const row = el('div', 'side');
  if (winSide) row.classList.add(which === winSide ? 'win' : 'lose');
  if (side && side.code) row.dataset.team = side.code;
  if (side.placeholder) {
    row.appendChild(el('span', 'flag tbd', '?'));
    row.appendChild(el('span', 'nm ph', side.placeholder));
  } else {
    row.innerHTML = `<img class="flag" src="${flagURL(side.code)}" alt="${side.name}" loading="lazy" width="20" height="15">`
      + `<span class="nm">${side.name}</span>`;
  }
  if (showScore && !side.placeholder) row.appendChild(el('span', 'sc tnum', String(numOr0(dScore(m, which)))));
  return row;
}

// === updated stamp =========================================================
function renderUpdated() {
  const u = DATA.meta.updated_utc;
  const node = $('#updated');
  if (u) {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    node.innerHTML = `Live results last synced <b>${f.format(new Date(u))}</b> Riyadh · ${DATA.meta.total_matches} matches`;
  } else {
    node.innerHTML = `Full fixture list · ${DATA.meta.total_matches} matches · results sync automatically once play begins`;
  }
}

// === tabs + scroll =========================================================
function selectTab(target) {
  const tabs = [...document.querySelectorAll('.tab')];
  const tab = tabs.find((t) => t.dataset.view === target) || tabs[0];
  tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
  const view = tab.dataset.view;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  $('#daystrip').style.display = view === 'matches' ? '' : 'none';
  syncBarHeight();
  if (pillEl) updateNowPill();
}

function wireTabs() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    selectTab(tab.dataset.view);
    history.replaceState(null, '', `#${tab.dataset.view}`);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }));
  const hash = location.hash.slice(1);
  if (['groups', 'bracket'].includes(hash)) selectTab(hash);
}

function scrollToToday() {
  const view = $('#view-matches');
  const tk = todayKey();
  let sec = view.querySelector(`[data-day="${CSS.escape(tk)}"]`);
  if (!sec) {
    // no match today — jump to the next upcoming day
    const all = [...view.querySelectorAll('[data-day]')];
    sec = all.find((s) => s.dataset.day >= tk) || all[0];
  }
  if (sec) {
    const top = sec.getBoundingClientRect().top + window.scrollY - 124;
    // when today sits near the very top (opening days), stay at 0 so the
    // "Your teams" strip above it remains visible instead of being scrolled off.
    const strip = view.querySelector('.pinstrip');
    const stripBottom = strip ? strip.offsetTop + strip.offsetHeight : 0;
    window.scrollTo({ top: top <= stripBottom + 60 ? 0 : Math.max(0, top), behavior: 'auto' });
  }
}

// keep the day-strip chip in sync with the section nearest the top
function observeDays(view, strip) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const k = e.target.dataset.day;
        strip.querySelectorAll('.chip').forEach((c) => {
          c.dataset.active = String(c.dataset.target === k);
          if (c.dataset.target === k) c.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        });
      }
    }
  }, { rootMargin: '-120px 0px -70% 0px', threshold: 0 });
  view.querySelectorAll('[data-day]').forEach((s) => io.observe(s));
}

// === pinned teams: strip + highlighting ====================================
function renderPinStrip() {
  const codes = [...PINS].filter((c) => CODE_INDEX.has(c));
  if (!codes.length) return null;
  const wrap = el('div', 'pinstrip');
  wrap.appendChild(el('div', 'pinstrip-h', 'Your teams'));
  const cards = el('div', 'pinstrip-cards');
  for (const code of codes) cards.appendChild(pinCard(code));
  wrap.appendChild(cards);
  return wrap;
}

function pinCard(code) {
  const team = CODE_INDEX.get(code);
  const list = matchesForCode(code);
  const statusOf = (x) => dStatus(x.m);
  const pick = list.find((x) => statusOf(x) === 'live')
    || list.find((x) => statusOf(x) === 'upcoming' && Date.parse(x.m.kickoff_utc) >= NOW)
    || [...list].reverse().find((x) => statusOf(x) === 'finished')
    || null;

  const card = el('button', 'pincard');
  card.type = 'button';
  let sub = 'No upcoming match';
  if (pick) {
    const { m, side } = pick;
    const r = RES.resolved.get(m.id);
    const opp = side === 'home' ? r.away : r.home;
    const oppName = opp.placeholder ? 'TBD' : opp.name;
    const st = dStatus(m);
    const me = numOr0(dScore(m, side));
    const them = numOr0(dScore(m, side === 'home' ? 'away' : 'home'));
    if (st === 'live') {
      const min = dMinute(m);
      sub = `<b class="lv">● LIVE${min ? ` ${min}` : ''}</b> ${me}–${them} v ${oppName}`;
    } else if (st === 'finished') {
      sub = `FT ${me}–${them} v ${oppName}`;
    } else {
      sub = `${fmtChip.format(new Date(m.kickoff_utc))}, ${fmtTime.format(new Date(m.kickoff_utc))} v ${oppName}`;
    }
    card.addEventListener('click', () => goToMatch(m.id));
  }
  card.innerHTML = `<img class="flag" src="${flagURL(code)}" alt="" width="28" height="21">`
    + `<span class="pc-body"><span class="pc-name">${team.name}</span><span class="pc-sub">${sub}</span></span>`;
  return card;
}

function applyPins() {
  document.querySelectorAll('.team[data-team], .strow[data-team], .tie .side[data-team]')
    .forEach((node) => node.classList.toggle('pinned', isPinned(node.dataset.team)));
  document.querySelectorAll('.star[data-team]').forEach((b) => {
    const on = isPinned(b.dataset.team);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('.match').forEach((row) => {
    row.classList.toggle('haspin', isPinned(row.dataset.homeCode) || isPinned(row.dataset.awayCode));
  });
  const view = $('#view-matches');
  const existing = view && view.querySelector('.pinstrip');
  const fresh = renderPinStrip();
  if (existing) { if (fresh) existing.replaceWith(fresh); else existing.remove(); }
  else if (fresh && view) view.insertBefore(fresh, view.firstChild);
}

function goToMatch(id) {
  selectTab('matches');
  history.replaceState(null, '', '#matches');
  // measure AFTER the matches view is shown (selectTab may have just unhidden
  // it), and offset by the REAL occluding height: sticky top bar + the section's
  // sticky day header. The old fixed -132 was shorter than the bar on mobile, so
  // the target landed under it — worst for the first match. This lands it fully
  // in view for every match, first included.
  requestAnimationFrame(() => {
    const target = document.getElementById(`m${id}`);
    if (!target) return;
    const barH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bar-h'), 10) || 120;
    const hdr = target.closest('section') && target.closest('section').querySelector('.dayhdr');
    const offset = barH + (hdr ? hdr.offsetHeight : 0) + 12;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth; // restart the flash animation
    target.classList.add('flash');
  });
}

// === Now / Next pill =======================================================
let pillEl, pillTimer, pillIO;
const flagMini = (s) => (s && s.code ? `<img class="npflag" src="${flagURL(s.code)}" alt="" width="20" height="15">` : '');
const nameOf = (s) => (s.placeholder ? 'TBD' : s.name);

function fmtCountdown(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `in ${h}h ${mins % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

function pickFeature() {
  const sorted = [...DATA.matches].sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc));
  const live = sorted.find((m) => dStatus(m) === 'live');
  if (live) return { m: live, kind: 'live' };
  const next = sorted.find((m) => dStatus(m) === 'upcoming' && Date.parse(m.kickoff_utc) >= Date.now());
  return next ? { m: next, kind: 'next' } : null;
}

function setupNowPill() {
  pillEl = document.getElementById('nowpill');
  if (!pillEl) {
    pillEl = el('button', 'nowpill');
    pillEl.id = 'nowpill';
    pillEl.type = 'button';
    pillEl.hidden = true;
    pillEl.addEventListener('click', () => { if (pillEl.dataset.go) goToMatch(+pillEl.dataset.go); });
    document.body.appendChild(pillEl);
  }
  observePillVisibility();
  updateNowPill();
  clearInterval(pillTimer);
  pillTimer = setInterval(updateNowPill, 30000);
}

function todaySection() {
  const view = $('#view-matches');
  if (!view) return null;
  const tk = todayKey();
  return view.querySelector(`[data-day="${CSS.escape(tk)}"]`)
    || [...view.querySelectorAll('[data-day]')].find((s) => s.dataset.day >= tk)
    || null;
}

// "away" = today's slate is NOT within the comfortable reading band.
function isTodayAway() {
  const sec = todaySection();
  if (!sec) return false;
  const r = sec.getBoundingClientRect();
  if (!r.height) return false; // not laid out yet (avoids a pre-layout false positive)
  const bar = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bar-h'), 10) || 120;
  // away only when today's slate is fully above the bar (scrolled past) or fully
  // below the viewport (not yet reached) — robust to the bar + strip offset.
  return r.bottom < bar + 24 || r.top > window.innerHeight - 8;
}

// IntersectionObserver just nudges the pill to re-evaluate on scroll crossings;
// the actual show/hide decision is geometric (updateNowPill -> isTodayAway).
function observePillVisibility() {
  if (pillIO) pillIO.disconnect();
  const target = todaySection();
  if (!target) return;
  const bar = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bar-h'), 10) || 120;
  pillIO = new IntersectionObserver(() => updateNowPill(),
    { rootMargin: `-${bar}px 0px -45% 0px`, threshold: [0, 1] });
  pillIO.observe(target);
}

function updateNowPill() {
  if (!pillEl) return;
  const feat = pickFeature();
  if (!feat) { pillEl.hidden = true; return; }
  const { m, kind } = feat;
  const r = RES.resolved.get(m.id);
  pillEl.classList.toggle('pinned', isPinned(r.home.code) || isPinned(r.away.code));
  if (kind === 'live') {
    pillEl.dataset.live = '1';
    const min = dMinute(m);
    pillEl.innerHTML = `<span class="np-dot"></span>`
      + `<span class="np-main">${flagMini(r.home)}<b class="tnum">${numOr0(dScore(m, 'home'))}</b>`
      + `<span class="np-v">–</span><b class="tnum">${numOr0(dScore(m, 'away'))}</b>${flagMini(r.away)}</span>`
      + `<span class="np-tag">LIVE${min ? ` ${min}` : ''}</span>`;
  } else {
    delete pillEl.dataset.live;
    const cd = fmtCountdown(Date.parse(m.kickoff_utc) - Date.now());
    pillEl.innerHTML = `<span class="np-lead">Next</span>`
      + `<span class="np-main">${flagMini(r.home)}<span class="np-nm">${nameOf(r.home)}</span>`
      + `<span class="np-v">v</span><span class="np-nm">${nameOf(r.away)}</span>${flagMini(r.away)}</span>`
      + `<span class="np-tag">${cd}</span>`;
  }
  pillEl.dataset.go = m.id;
  const matchesTab = !$('#view-matches').hidden;
  pillEl.hidden = !(kind === 'live' || (matchesTab && isTodayAway()));
}

// === live self-refresh (own JSON, network-first) ===========================
let lastJSON;
function shouldPoll() {
  const now = Date.now();
  return DATA.matches.some((m) => {
    const ko = Date.parse(m.kickoff_utc);
    return RES.resolved.get(m.id).status === 'live'
      || (ko - now < 30 * 60000 && now - ko < 150 * 60000);
  });
}
function setupLiveRefresh() {
  lastJSON = JSON.stringify(DATA);
  setInterval(maybeRefresh, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeRefresh();
  });
}
async function maybeRefresh() {
  if (document.visibilityState !== 'visible') return;
  if (!shouldPoll()) { NOW = Date.now(); updateNowPill(); return; }
  try {
    const res = await fetch('data/tournament.json', { cache: 'no-store' });
    const txt = await res.text();
    if (txt && txt !== lastJSON) {
      lastJSON = txt;
      DATA = JSON.parse(txt);
      NOW = Date.now();
      rerenderAll();
      observePillVisibility();
    } else {
      NOW = Date.now();
      updateNowPill();
    }
  } catch (e) { /* offline — keep last-known data on screen */ }
}

// === FIFA live overlay (key-free, CORS-open, overlay-only) =================
// Polls FIFA's calendar feed while a WC match is live (or about to be) and the
// tab is visible; overlays goals + minute onto live rows + the pill via LIVE_OV.
// Best-effort: errors back off and we silently fall back to the committed cron
// data. It never mutates DATA or the bracket.
const FIFA_LIVE_URL = 'https://api.fifa.com/api/v3/calendar/matches?idCompetition=17&idSeason=285023&count=500&language=en';
const FIFA_BASE_MS = 45000;
let fifaTimer = null, fifaBackoff = 0;

function setupFifaLive() {
  scheduleFifa(2500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleFifa(1500);
  });
}
function scheduleFifa(delay) {
  clearTimeout(fifaTimer);
  fifaTimer = setTimeout(fifaTick, delay);
}
function overlayEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.home !== v.home || w.away !== v.away || w.min !== v.min || w.status !== v.status) return false;
  }
  return true;
}
async function fifaTick() {
  if (document.visibilityState !== 'visible' || (!shouldPoll() && LIVE_OV.size === 0)) {
    scheduleFifa(FIFA_BASE_MS);
    return;
  }
  try {
    const res = await fetch(FIFA_LIVE_URL, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const json = await res.json();
    const rows = json.Results || [];
    if (rows.length < 64) throw new Error('unexpected shape');
    const committed = new Map(DATA.matches.map((m) => [m.id, m]));
    const next = new Map();
    for (const r of rows) {
      if (!MATCH_IDS.has(r.MatchNumber)) continue;
      const fhs = r.HomeTeamScore == null ? null : Number(r.HomeTeamScore);
      const fas = r.AwayTeamScore == null ? null : Number(r.AwayTeamScore);
      if (r.MatchStatus === 3) {
        next.set(r.MatchNumber, {
          home: fhs == null ? 0 : fhs, away: fas == null ? 0 : fas,
          min: typeof r.MatchTime === 'string' ? r.MatchTime : '', status: 'live',
        });
      } else if (Number.isFinite(fhs) && Number.isFinite(fas)) {
        // FIFA reports it finished — bridge until the committed file catches up,
        // so a just-ended match shows the real final instead of a stale live score
        const cm = committed.get(r.MatchNumber);
        const caught = cm && cm.status === 'finished' && cm.home_score === fhs && cm.away_score === fas;
        if (!caught) next.set(r.MatchNumber, { home: fhs, away: fas, min: '', status: 'finished' });
      }
    }
    fifaBackoff = 0;
    if (!overlayEqual(LIVE_OV, next)) {
      LIVE_OV = next;
      rerenderAll();
      observePillVisibility();
    }
    scheduleFifa(FIFA_BASE_MS);
  } catch (e) {
    fifaBackoff = Math.min(5, fifaBackoff + 1);
    if (fifaBackoff >= 3 && LIVE_OV.size) { // give up the overlay; fall back to committed
      LIVE_OV = new Map();
      rerenderAll();
    }
    scheduleFifa(FIFA_BASE_MS * (1 + fifaBackoff));
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* non-fatal */ });
}

boot();
