// Pure parsers and models for the extra signals: Vegas lines, kickoff state,
// snap/target usage, ESPN news and imported expert rankings. No DOM/network.

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round1 = (n) => Math.round(n * 10) / 10;

const TEAM_ALIAS = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR', ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU', SD: 'LAC', STL: 'LAR', OAK: 'LV' };
export const normTeam = (t) => { const u = String(t ?? '').toUpperCase().trim(); return TEAM_ALIAS[u] ?? u; };

// ---------- Lines & kickoff (ESPN scoreboard) ----------

/** ESPN odds look like { details: "KC -3.5", overUnder: 47.5, spread: -3.5 }. */
export function parseOdds(odds, comp = {}) {
  if (!odds) return { total: null, margin: null, favorite: null };
  const total = Number(odds.overUnder);
  let favorite = null, margin = null;
  const m = String(odds.details ?? '').trim().match(/^([A-Za-z]{2,4})\s+([-+]?\d+(?:\.\d+)?)$/);
  if (m) { favorite = normTeam(m[1]); margin = Math.abs(parseFloat(m[2])); }
  else if (/^(even|pk|pick)/i.test(String(odds.details ?? '').trim())) margin = 0;
  else if (Number.isFinite(Number(odds.spread))) {
    margin = Math.abs(Number(odds.spread));
    const homeFav = odds.homeTeamOdds?.favorite;
    const home = comp.competitors?.find(c => c.homeAway === 'home')?.team?.abbreviation;
    const away = comp.competitors?.find(c => c.homeAway === 'away')?.team?.abbreviation;
    if (typeof homeFav === 'boolean' && home && away) favorite = normTeam(homeFav ? home : away);
  }
  return { total: Number.isFinite(total) && total > 0 ? total : null, margin, favorite };
}

export function parseScoreboard(json) {
  const games = [];
  for (const ev of json?.events ?? []) {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === 'home')?.team?.abbreviation;
    const away = comp?.competitors?.find(c => c.homeAway === 'away')?.team?.abbreviation;
    if (!home || !away) continue;
    games.push({
      home: normTeam(home), away: normTeam(away),
      kickoff: ev.date ?? comp.date ?? null,
      state: ev.status?.type?.state ?? comp.status?.type?.state ?? 'pre', // pre | in | post
      indoor: !!comp.venue?.indoor,
      ...parseOdds(comp.odds?.[0], comp),
    });
  }
  return games;
}

/** team -> { opp, home, kickoff, state, total, margin (+ = favorite), implied, oppImplied } */
export function buildSlate(games) {
  const slate = {};
  for (const g of games ?? []) {
    let hi = null, ai = null;
    if (g.total != null && g.margin != null) {
      const fav = (g.total + g.margin) / 2, dog = (g.total - g.margin) / 2;
      if (g.favorite === g.home) { hi = fav; ai = dog; }
      else if (g.favorite === g.away) { ai = fav; hi = dog; }
      else { hi = ai = g.total / 2; }
    }
    const base = { kickoff: g.kickoff, state: g.state, total: g.total, indoor: g.indoor };
    const signed = (team) => g.margin == null ? null : g.favorite == null ? 0 : (g.favorite === team ? g.margin : -g.margin);
    slate[g.home] = { ...base, opp: g.away, home: true, margin: signed(g.home), implied: hi, oppImplied: ai };
    slate[g.away] = { ...base, opp: g.home, home: false, margin: signed(g.away), implied: ai, oppImplied: hi };
  }
  return slate;
}

export function slateAverage(slate) {
  const v = Object.values(slate ?? {}).map(s => s.implied).filter(x => x != null);
  return v.length >= 8 ? v.reduce((a, b) => a + b, 0) / v.length : 22.5;
}

/** Players whose game has started (or finished) are locked in Sleeper. */
export function isLocked(team, slate, now = Date.now()) {
  const g = slate?.[team];
  if (!g) return false;
  if (g.state && g.state !== 'pre') return true;
  return g.kickoff ? Date.parse(g.kickoff) <= now : false;
}

export const VEGAS_WEIGHT = 0.6; // Sleeper's projections already price in part of the line.

/**
 * Game-environment multiplier. Pass catchers and QBs follow the team's implied
 * total; RBs also like being favored (clock-killing volume); kickers follow the
 * total; defenses benefit when the opponent's implied total is low.
 */
export function vegasMultiplier(pos, env, avg = 22.5) {
  if (!env || env.implied == null) return 1;
  const tf = (env.implied - avg) / avg;
  const margin = clamp(env.margin ?? 0, -10, 10);
  let m = 0;
  if (pos === 'QB' || pos === 'WR' || pos === 'TE') m = 0.6 * tf;
  else if (pos === 'RB') m = 0.3 * tf + 0.008 * margin;
  else if (pos === 'K') m = 0.5 * tf;
  else if (pos === 'DEF' && env.oppImplied != null) m = 0.5 * ((avg - env.oppImplied) / avg);
  return 1 + clamp(m * VEGAS_WEIGHT, -0.12, 0.12);
}

// ---------- Snap share & target share (Sleeper weekly stats) ----------

/**
 * weekly: array (week 1..n-1) of { playerId: { stats, team } }.
 * Returns id -> { games, snap:{l3,season}, tgt:{l3,season}, rush:{l3,season}, tgtPerGame }.
 * Team target/rush totals are the sum over players on that team that week.
 */
export function buildUsage(weekly, players) {
  const totals = weekly.map(wk => {
    const t = {};
    for (const [id, row] of Object.entries(wk ?? {})) {
      const team = row.team ?? players[id]?.team;
      if (!team) continue;
      const o = (t[team] ??= { tgt: 0, rush: 0 });
      o.tgt += row.stats?.rec_tgt ?? 0;
      o.rush += row.stats?.rush_att ?? 0;
    }
    return t;
  });
  const per = {};
  weekly.forEach((wk, w) => {
    for (const [id, row] of Object.entries(wk ?? {})) {
      const p = players[id];
      if (!p || !['RB', 'WR', 'TE'].includes(p.pos)) continue;
      const s = row.stats ?? {};
      if (!s.off_snp || !s.tm_off_snp) continue;
      const tt = totals[w][row.team ?? p.team];
      (per[id] ??= []).push({
        snap: s.off_snp / s.tm_off_snp,
        tgt: tt?.tgt ? (s.rec_tgt ?? 0) / tt.tgt : null,
        rush: tt?.rush ? (s.rush_att ?? 0) / tt.rush : null,
        tgtN: s.rec_tgt ?? 0,
      });
    }
  });
  const avg = (rows, k) => {
    const v = rows.map(r => r[k]).filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const out = {};
  for (const [id, rows] of Object.entries(per)) {
    const l3 = rows.slice(-3);
    out[id] = {
      games: rows.length,
      snap: { l3: avg(l3, 'snap'), season: avg(rows, 'snap') },
      tgt: { l3: avg(l3, 'tgt'), season: avg(rows, 'tgt') },
      rush: { l3: avg(l3, 'rush'), season: avg(rows, 'rush') },
      tgtPerGame: round1(l3.reduce((t, r) => t + r.tgtN, 0) / l3.length),
    };
  }
  return out;
}

const WEIGHTS = { WR: { tgt: 0.6, snap: 0.4 }, TE: { tgt: 0.6, snap: 0.4 }, RB: { snap: 0.5, rush: 0.3, tgt: 0.2 } };
function opportunity(u, pos, which) {
  const w = WEIGHTS[pos];
  if (!w) return null;
  let sum = 0, tot = 0;
  for (const [k, wt] of Object.entries(w)) {
    const v = u[k]?.[which];
    if (v != null) { sum += v * wt; tot += wt; }
  }
  return tot ? sum / tot : null;
}

/** Recent role (last 3 games) vs. the season: rising usage → small boost, falling → small cut. */
export function usageMultiplier(pos, u) {
  if (!u || u.games < 4) return { mult: 1, trend: 0, ok: false };
  const l3 = opportunity(u, pos, 'l3'), season = opportunity(u, pos, 'season');
  if (l3 == null || !season || season < 0.02) return { mult: 1, trend: 0, ok: false };
  const trend = l3 / season - 1;
  return { mult: 1 + clamp(trend * 0.3, -0.1, 0.1), trend, ok: true };
}

// ---------- News (ESPN) ----------

export function parseNews(json) {
  const out = [];
  for (const a of json?.articles ?? json?.feed ?? []) {
    const ids = [];
    for (const c of a.categories ?? []) {
      const id = c.athleteId ?? c.athlete?.id ?? (c.type === 'athlete' ? c.id : null);
      if (id != null) ids.push(String(id));
    }
    if (!ids.length || !a.headline) continue;
    out.push({
      headline: a.headline, description: a.description ?? '', published: a.published ?? a.lastModified ?? null,
      url: a.links?.web?.href ?? null, athleteIds: [...new Set(ids)],
    });
  }
  return out;
}

/** espn athlete id -> sleeper id, newest 3 items per player from the last 7 days. */
export function newsByPlayer(items, players, now = Date.now()) {
  const byEspn = {};
  for (const p of Object.values(players)) if (p.espnId != null) byEspn[String(p.espnId)] = p.id;
  const out = {};
  for (const n of items) {
    if (n.published && now - Date.parse(n.published) > 7 * 864e5) continue;
    for (const eid of n.athleteIds) {
      const id = byEspn[eid];
      if (id) (out[id] ??= []).push(n);
    }
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => Date.parse(b.published ?? 0) - Date.parse(a.published ?? 0));
    list.length = Math.min(list.length, 3);
  }
  return out;
}

// ---------- Expert rankings (CSV import) ----------

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(x => x.trim())) rows.push(row);
  return rows;
}

const POS_ALIAS = { DST: 'DEF', 'D/ST': 'DEF', DEFENSE: 'DEF', PK: 'K' };

/** Accepts FantasyPros-style exports (RK, PLAYER NAME, TEAM, POS="WR12") or generic rank/name/team/pos CSVs. */
export function parseRankingsCSV(text) {
  const rows = parseCSV(String(text ?? '').replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (re) => head.findIndex(h => re.test(h));
  const iRank = col(/^(rk|rank|ecr|avg\.? ?rank|overall)$/);
  const iName = col(/^(player ?name|name|player)$/);
  const iTeam = col(/^(team|tm)$/);
  const iPos = col(/^(pos|position)$/);
  if (iName < 0) return [];
  const out = [];
  rows.slice(1).forEach((r, n) => {
    const name = (r[iName] ?? '').trim();
    if (!name) return;
    const pm = String(r[iPos] ?? '').trim().toUpperCase().match(/^([A-Z/]+?)(\d+)?$/);
    const pos = pm ? (POS_ALIAS[pm[1]] ?? pm[1]) : null;
    const rank = iRank >= 0 ? parseFloat(r[iRank]) : n + 1;
    out.push({ name, team: iTeam >= 0 ? normTeam(r[iTeam]) : null, pos, rank: Number.isFinite(rank) ? rank : n + 1, posRank: pm?.[2] ? +pm[2] : null });
  });
  // Positional ranks, when the file only has overall ranks.
  const seen = {};
  for (const r of [...out].sort((a, b) => a.rank - b.rank)) {
    if (!r.pos) continue;
    seen[r.pos] = (seen[r.pos] ?? 0) + 1;
    if (r.posRank == null) r.posRank = seen[r.pos];
  }
  return out.filter(r => r.pos && r.posRank);
}

export const nameKey = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[.'’`-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

/** rows -> { sleeperId: { posRank, rank } }; returns also the number of unmatched rows. */
export function matchRankings(rows, players) {
  const byName = {}, defByTeam = {};
  for (const p of Object.values(players)) {
    if (p.pos === 'DEF') { if (p.team) defByTeam[normTeam(p.team)] = p; continue; }
    (byName[`${nameKey(p.name)}|${p.pos}`] ??= []).push(p);
  }
  const map = {}; let unmatched = 0;
  for (const r of rows) {
    let p = null;
    if (r.pos === 'DEF') p = defByTeam[r.team] ?? null;
    else {
      const c = byName[`${nameKey(r.name)}|${r.pos}`];
      p = c ? (c.find(x => normTeam(x.team) === r.team) ?? c[0]) : null;
    }
    if (p) map[p.id] = { posRank: r.posRank, rank: r.rank }; else unmatched++;
  }
  return { map, unmatched };
}

/**
 * Combine several ranking sets. Each set: { id, name, weight, rows }. A player's
 * rank is the weighted mean of his positional rank across the sources that rank
 * him (ranks can be fractional); `ranks` keeps each source's own number for display.
 */
export function aggregateRankings(sets, players) {
  const per = {}, perSource = [];
  for (const set of sets) {
    const { map, unmatched } = matchRankings(set.rows, players);
    perSource.push({ id: set.id, name: set.name, matched: Object.keys(map).length, unmatched });
    for (const [id, r] of Object.entries(map)) (per[id] ??= []).push({ id: set.id, name: set.name, posRank: r.posRank, w: set.weight ?? 1 });
  }
  const map = {};
  for (const [id, list] of Object.entries(per)) {
    const tw = list.reduce((t, x) => t + x.w, 0);
    const mean = list.reduce((t, x) => t + x.posRank * x.w, 0) / tw;
    map[id] = { posRank: Math.round(mean * 10) / 10, n: list.length, ranks: list.map(({ id, name, posRank }) => ({ id, name, posRank })) };
  }
  return { map, perSource };
}

export const fmtKickoff = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(+d) ? null : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
