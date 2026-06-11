// app.js — rendering + interaction. iPhone-first. All clock display goes
// through the Asia/Riyadh timezone API (never a hardcoded +3 offset).
import { resolve, hasScore } from './engine.js';

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
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
});
const fmtDayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fmtChip = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' });

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

// ---------------------------------------------------------------------------
let DATA, RES, NOW;
const todayKey = () => fmtKey.format(new Date(NOW));

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

  renderHosts();
  renderMatches();
  renderGroups();
  renderBracket();
  renderUpdated();
  wireTabs();

  syncBarHeight();
  window.addEventListener('resize', syncBarHeight);

  // jump the matches view to today (or the next match day)
  requestAnimationFrame(scrollToToday);
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
  row.dataset.status = r.status;
  row.dataset.stage = m.stage;
  row.id = `m${m.id}`;

  // left: kickoff time + late badge
  const ko = el('div', 'kotime');
  ko.appendChild(el('div', 't tnum', fmtTime.format(new Date(m.kickoff_utc))));
  const stageMeta = m.stage === 'group' ? `Group ${m.group}` : ROUND_SHORT[m.stage];
  ko.appendChild(el('div', 'meta', `#${m.id} · ${stageMeta}`));
  const h = riyadhHour(m.kickoff_utc);
  if (h < 6) {
    ko.appendChild(el('span', 'late', `🌙 ${prevWeekday(m.kickoff_utc)} night`));
  }
  row.appendChild(ko);

  // middle: teams
  const winSide = winnerSide(m);
  const teams = el('div', 'teams');
  teams.appendChild(teamLine(r.home, m, 'home', winSide));
  teams.appendChild(teamLine(r.away, m, 'away', winSide));
  row.appendChild(teams);

  // right: status rail
  const rail = el('div', 'rail');
  if (r.status === 'live') {
    rail.appendChild(el('span', 'pill live', '<span class="dot"></span>LIVE'));
  } else if (r.status === 'finished') {
    rail.appendChild(el('span', 'pill ft', m.stage === 'group' ? 'FT' : ftLabel(m)));
  } else if (isNext) {
    rail.appendChild(el('span', 'pill grp', 'NEXT'));
  }
  rail.appendChild(el('span', 'venue', m.city || m.venue || ''));
  row.appendChild(rail);

  return row;
}

function ftLabel(m) {
  // note penalties on a knockout that was level after normal/extra time
  if (hasScore(m) && m.home_score === m.away_score && m.winner) return 'FT · PENS';
  return 'FT';
}

function teamLine(side, m, which, winSide) {
  const line = el('div', 'team');
  const isPlaceholder = !!side.placeholder;
  if (winSide) {
    line.classList.add(which === winSide ? 'win' : 'lose');
  }
  if (isPlaceholder) {
    line.appendChild(el('span', 'flag tbd', '?'));
    line.appendChild(el('span', 'name ph', side.placeholder));
  } else {
    const img = el('img', 'flag');
    img.src = flagURL(side.code);
    img.alt = side.name;
    img.loading = 'lazy';
    img.width = 26; img.height = 19;
    line.appendChild(img);
    line.appendChild(el('span', 'name', side.name));
  }
  const score = which === 'home' ? m.home_score : m.away_score;
  if (Number.isFinite(score)) {
    const pen = which === 'home' ? m.home_pens : m.away_pens;
    const sc = el('span', 'sc tnum', String(score));
    if (Number.isFinite(pen)) sc.appendChild(el('span', 'pens', `(${pen})`));
    line.appendChild(sc);
  }
  return line;
}

// === GROUPS ================================================================
function renderGroups() {
  const view = $('#view-groups');
  view.innerHTML = '';
  const grid = el('div', 'grpgrid');

  for (const [g, s] of Object.entries(RES.standings)) {
    const card = el('div', 'gcard');
    card.appendChild(el('h3', null, `Group <span>${g}</span>`));

    const head = el('div', 'strow head');
    head.innerHTML = '<span class="pos">#</span><span></span><span class="nm">Team</span>'
      + '<span class="v">P</span><span class="v">W</span><span class="v">D</span><span class="v">GD</span><span class="pts">Pts</span>';
    card.appendChild(head);

    s.table.forEach((t, i) => {
      const adv = i < 2 ? '1' : (i === 2 ? '3' : '');
      const r = el('div', 'strow');
      if (adv) r.dataset.adv = adv;
      const img = `<img class="flag" src="${flagURL(t.team.code)}" alt="${t.team.name}" loading="lazy" width="22" height="16">`;
      r.innerHTML = `<span class="pos">${i + 1}</span>${img}<span class="nm">${t.team.name}</span>`
        + `<span class="v tnum">${t.P}</span><span class="v tnum">${t.W}</span><span class="v tnum">${t.D}</span>`
        + `<span class="v tnum">${t.GD > 0 ? '+' : ''}${t.GD}</span><span class="pts tnum">${t.Pts}</span>`;
      card.appendChild(r);
    });
    grid.appendChild(card);
  }
  view.appendChild(grid);

  const key = el('div', 'adv-key');
  key.innerHTML = '<span><i class="q"></i>Top 2 advance</span><span><i class="t"></i>3rd → 8 best qualify</span>';
  view.appendChild(key);
  view.appendChild(el('p', 'hint',
    'Standings update automatically as results land. Order: points, then goal difference, then goals scored.'));
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
  const card = el('div', 'tie');
  card.dataset.status = r.status;
  if (m.stage === 'final') card.classList.add('champ');

  const head = el('div', 'mno');
  head.innerHTML = `<span>Match ${m.id}</span><span>${fmtChip.format(new Date(m.kickoff_utc))} · ${fmtTime.format(new Date(m.kickoff_utc))}</span>`;
  card.appendChild(head);

  const winSide = winnerSide(m);
  card.appendChild(tieSide(r.home, m, 'home', winSide));
  card.appendChild(tieSide(r.away, m, 'away', winSide));
  return card;
}

function tieSide(side, m, which, winSide) {
  const row = el('div', 'side');
  if (winSide) row.classList.add(which === winSide ? 'win' : 'lose');
  if (side.placeholder) {
    row.appendChild(el('span', 'flag tbd', '?'));
    row.appendChild(el('span', 'nm ph', side.placeholder));
  } else {
    row.innerHTML = `<img class="flag" src="${flagURL(side.code)}" alt="${side.name}" loading="lazy" width="20" height="15">`
      + `<span class="nm">${side.name}</span>`;
  }
  const score = which === 'home' ? m.home_score : m.away_score;
  if (Number.isFinite(score)) row.appendChild(el('span', 'sc tnum', String(score)));
  return row;
}

// === updated stamp =========================================================
function renderUpdated() {
  const u = DATA.meta.updated_utc;
  const node = $('#updated');
  if (u) {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
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
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
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

boot();
