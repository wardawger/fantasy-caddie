// Pure analytics: projections → player values → lineups, waivers, FAB, trades.
// No DOM or network here so it can be unit-tested in Node.

import { vegasMultiplier, usageMultiplier, isLocked } from './signals.js';

export const LAST_WEEK = 17;

const SLOT_ELIGIBILITY = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};
export const isStartingSlot = (s) => s in SLOT_ELIGIBILITY;

// Share of a player's remaining games expected to be lost to the listed injury.
const INJURY = {
  IR: { week: 0, gamesLost: 4 },
  PUP: { week: 0, gamesLost: 4 },
  Sus: { week: 0, gamesLost: 1 },
  Out: { week: 0, gamesLost: 1 },
  Doubtful: { week: 0.2, gamesLost: 0.8 },
  Questionable: { week: 0.85, gamesLost: 0.15 },
};

export function fantasyPoints(stats, scoring) {
  if (!stats) return 0;
  let pts = 0;
  for (const [k, v] of Object.entries(stats)) {
    const w = scoring[k];
    if (typeof w === 'number' && typeof v === 'number') pts += v * w;
  }
  return pts;
}

export function remainingWeeks(week) {
  return Math.max(0, LAST_WEEK - week + 1);
}

// Points allowed by each defense to each position relative to league average,
// built from weekly box scores so far. Shrunk toward 1 because Sleeper's own
// projections already account for the opponent partly.
export function buildDvP(weeklyStats, players, scoring) {
  // Points each defense allowed to each position per game: sum every opposing
  // player's points in a game, then average over the games played. (Averaging per
  // player would just measure how many scrubs happened to be listed.)
  const perGame = {}; // team -> pos -> [week -> pts]
  const weeksSeen = {}; // team -> number of weeks it appears as an opponent
  weeklyStats.forEach((wk, w) => {
    const seen = new Set();
    for (const [id, row] of Object.entries(wk)) {
      const p = players[id];
      if (!p || !row.opponent) continue;
      seen.add(row.opponent);
      const pts = fantasyPoints(row.stats, scoring);
      const t = ((perGame[row.opponent] ??= {})[p.pos] ??= []);
      t[w] = (t[w] ?? 0) + pts;
    }
    for (const t of seen) weeksSeen[t] = (weeksSeen[t] ?? 0) + 1;
  });
  const avgOf = (arr) => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const teamAvg = {}; const lg = {};
  for (const [team, byPos] of Object.entries(perGame)) {
    for (const [pos, arr] of Object.entries(byPos)) {
      const a = avgOf(arr); if (a == null) continue;
      (teamAvg[team] ??= {})[pos] = a;
      (lg[pos] ??= []).push(a);
    }
  }
  const out = {};
  for (const [team, byPos] of Object.entries(teamAvg)) {
    out[team] = {};
    const trust = Math.min((weeksSeen[team] ?? 0) / 8, 1) * 0.6; // early season: mostly neutral
    for (const [pos, a] of Object.entries(byPos)) {
      const league = avgOf(lg[pos]);
      if (!league) continue;
      const m = 1 + (a / league - 1) * trust;
      out[team][pos] = Math.min(1.15, Math.max(0.85, m));
    }
  }
  return out;
}

export function weatherMultiplier(pos, wx) {
  if (!wx || wx.dome) return 1;
  let m = 1;
  const passGame = pos === 'QB' || pos === 'WR' || pos === 'TE';
  if (wx.windMph > 15) {
    if (passGame) m *= Math.max(0.85, 1 - (wx.windMph - 15) * 0.01);
    if (pos === 'RB' || pos === 'DEF') m *= 1.03;
  }
  if (wx.windMph > 12 && pos === 'K') m *= Math.max(0.75, 1 - (wx.windMph - 12) * 0.015);
  if (wx.precipMm >= 2) {
    if (passGame || pos === 'K') m *= 0.95;
    if (pos === 'RB' || pos === 'DEF') m *= 1.02;
  }
  if (wx.tempF != null && wx.tempF < 20 && (passGame || pos === 'K')) m *= 0.97;
  return m;
}

/**
 * ctx: { players, scoring, week, weekProj, seasonProj, seasonStats, dvp, weather, byes }
 * Returns id -> { week, rawWeek, rate, ros, notes[], opponent }
 *   week: adjusted projection for the current week (start/sit)
 *   rate: expected points per game for the rest of the season
 *   ros:  expected points for the rest of the season
 */
export function buildValues(ctx) {
  const { players, scoring, week } = ctx;
  const remWeeks = remainingWeeks(week);
  const xw = ctx.expertWeight ?? 0.25;

  // Distribution of Sleeper's weekly projections per position: lets an expert
  // positional rank (e.g. WR12) be translated into points in *this* league.
  const dist = {};
  for (const p of Object.values(players)) {
    const wp = ctx.weekProj?.[p.id];
    const pts = wp ? fantasyPoints(wp.stats, scoring) : 0;
    if (pts > 0) (dist[p.pos] ??= []).push(pts);
  }
  for (const a of Object.values(dist)) a.sort((x, y) => y - x);

  const out = {};
  for (const p of Object.values(players)) {
    const wp = ctx.weekProj?.[p.id];
    const sp = ctx.seasonProj?.[p.id];
    const st = ctx.seasonStats?.[p.id];
    const wkPts = wp ? fantasyPoints(wp.stats, scoring) : null;
    // Sleeper's season projections report gp=18 (weeks, not games); a team plays 17.
    // Team defenses are different: they report gp=1 next to season-long totals (and omit the
    // points/yards-allowed buckets), so dividing by gp inflated their per-game rate ~17x.
    // For defenses the weekly projection (which has the buckets) is the per-game rate.
    const projGames = p.pos === 'DEF' ? 17 : Math.min(sp?.stats?.gp || 17, 17);
    const projRate = p.pos === 'DEF' && wkPts != null ? wkPts : sp ? fantasyPoints(sp.stats, scoring) / projGames : 0;
    const actualRate = st?.games ? st.pts / st.games : null;
    // Blend preseason/ROS projection with realised production as games accrue.
    let rate = projRate;
    if (actualRate != null) {
      const w = Math.min(st.games, 8) / 16;
      rate = projRate ? projRate * (1 - w) + actualRate * w : actualRate;
    }
    if (!rate && wkPts) rate = wkPts;
    if (!rate) continue;

    const notes = [];
    const steps = [];
    const inj = INJURY[p.injury];
    const bye = ctx.byes?.[p.team];
    const onBye = bye === week;
    let games = remWeeks - (bye != null && bye >= week ? 1 : 0);
    if (inj) games = Math.max(0, games - inj.gamesLost);
    if (!p.team && p.pos !== 'DEF') games = 0;

    const base = wkPts ?? rate;
    let cur = base;
    const step = (key, label, mult, detail) => {
      const next = cur * mult;
      steps.push({ key, label, mult: Math.round(mult * 1000) / 1000, delta: round1(next - cur), after: round1(next), detail });
      cur = next;
    };

    if (onBye) { step('bye', 'Bye week', 0, 'Team is not playing'); notes.push({ kind: 'bye', text: 'On bye this week' }); }
    if (inj && cur > 0) {
      step('injury', `Injury: ${p.injury}`, inj.week, p.injuryNote ?? 'No detail reported');
      notes.push({ kind: 'injury', text: `${p.injury}${p.injuryNote ? ` · ${p.injuryNote}` : ''}` });
    } else if (inj) notes.push({ kind: 'injury', text: `${p.injury}${p.injuryNote ? ` · ${p.injuryNote}` : ''}` });

    const env = ctx.slate?.[p.team] ?? null;
    const opp = wp?.opponent ?? env?.opp ?? null;

    const dvp = opp ? ctx.dvp?.[opp]?.[p.pos] : null;
    if (dvp && cur > 0) {
      step('matchup', `Matchup vs ${opp}`, dvp, `${opp} allow ${Math.round(Math.abs(dvp - 1) * 100)}% ${dvp >= 1 ? 'more' : 'fewer'} ${p.pos} points than average (shrunk toward neutral)`);
      if (dvp >= 1.06) notes.push({ kind: 'matchup', good: true, text: `Soft matchup vs ${opp} (+${Math.round((dvp - 1) * 100)}%)` });
      else if (dvp <= 0.94) notes.push({ kind: 'matchup', good: false, text: `Tough matchup vs ${opp} (${Math.round((dvp - 1) * 100)}%)` });
    }

    const u = ctx.usage?.[p.id];
    const um = usageMultiplier(p.pos, u);
    if (um.ok && cur > 0) {
      const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
      const bits = [`snaps ${pct(u.snap.l3)} (season ${pct(u.snap.season)})`];
      if (p.pos !== 'RB' || u.tgt.l3 != null) bits.push(`targets ${pct(u.tgt.l3)} (season ${pct(u.tgt.season)})`);
      if (p.pos === 'RB') bits.push(`rush share ${pct(u.rush.l3)} (season ${pct(u.rush.season)})`);
      step('usage', 'Recent usage trend', um.mult, `Last 3 games vs season: ${bits.join(', ')}`);
      if (Math.abs(um.trend) >= 0.1) notes.push({ kind: 'usage', good: um.trend > 0, text: `Role ${um.trend > 0 ? 'growing' : 'shrinking'} (${um.trend > 0 ? '+' : ''}${Math.round(um.trend * 100)}% opportunity)` });
    }

    if (env && env.implied != null && cur > 0) {
      const m = vegasMultiplier(p.pos, env, ctx.slateAvg);
      const fav = env.margin > 0 ? `favored by ${env.margin}` : env.margin < 0 ? `${Math.abs(env.margin)}-pt underdog` : 'pick’em';
      step('vegas', 'Game script (Vegas)', m, `Implied team total ${round1(env.implied)} (slate avg ${round1(ctx.slateAvg ?? 22.5)}), ${fav}, O/U ${env.total}`);
      if (Math.abs(m - 1) >= 0.04) notes.push({ kind: 'vegas', good: m > 1, text: `${m > 1 ? 'High' : 'Low'} implied total ${round1(env.implied)} (${m > 1 ? '+' : ''}${Math.round((m - 1) * 100)}%)` });
    }

    const wx = ctx.weather?.[p.team];
    if (wx && cur > 0) {
      const m = weatherMultiplier(p.pos, wx);
      step('weather', 'Weather', m, wx.summary ?? '');
      if (Math.abs(m - 1) >= 0.02) notes.push({ kind: 'weather', good: m > 1, text: `${wx.summary} (${m > 1 ? '+' : ''}${Math.round((m - 1) * 100)}%)` });
    }

    // Expert consensus is blended last, and never lifts a player who is out or on bye.
    const ex = ctx.expert?.[p.id];
    const d = dist[p.pos];
    let expertPts = null;
    if (ex && d?.length) {
      const r = Math.max(1, Math.min(ex.posRank, d.length)), lo = Math.floor(r), hi = Math.ceil(r);
      expertPts = d[lo - 1] + (d[hi - 1] - d[lo - 1]) * (r - lo);
      if (xw > 0 && cur > 0) {
        step('expert', `Expert consensus (${p.pos}${ex.posRank}${ex.n > 1 ? `, ${ex.n} sources` : ''})`, (cur * (1 - xw) + expertPts * xw) / cur,
          `A ${p.pos}${ex.posRank} is worth about ${round1(expertPts)} pts in this league; blended at ${Math.round(xw * 100)}%`);
      }
    }

    out[p.id] = {
      id: p.id,
      pos: p.pos,
      week: round1(cur),
      rawWeek: wkPts == null ? null : round1(wkPts),
      rate: round1(rate),
      ros: round1(rate * Math.max(0, games)),
      notes,
      opponent: opp,
      kickoff: env?.kickoff ?? null,
      gameState: env?.state ?? null,
      breakdown: {
        base: round1(base), baseLabel: wkPts == null ? 'Season average (no weekly projection)' : 'Sleeper weekly projection',
        steps, final: round1(cur),
        facts: { usage: u ?? null, env, expert: ex ? { ...ex, pts: round1(expertPts ?? 0) } : null },
      },
    };
  }
  return out;
}

/**
 * Plain-English reasons for a swap: the base projections and the two biggest
 * adjustments (by points) on each side.
 */
const shortLabel = (l) => l.replace(/^Injury: /, '').replace(/^(Matchup|Weather|Bye|Game|Recent|Expert)/, m => m.toLowerCase());

export function explainMove(startId, sitId, values, players) {
  const line = (id, verb) => {
    const v = values[id]; const p = players[id];
    if (!v || !p) return null;
    const top = [...v.breakdown.steps].filter(s => Math.abs(s.delta) >= 0.3)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 2)
      .map(s => `${shortLabel(s.label)} ${s.delta > 0 ? '+' : '−'}${Math.abs(s.delta).toFixed(1)}`);
    return `${verb} ${p.name}: ${v.breakdown.base.toFixed(1)} → ${v.week.toFixed(1)} pts${top.length ? ` (${top.join(', ')})` : ' (no adjustments)'}`;
  };
  return [startId ? line(startId, 'Start') : null, sitId ? line(sitId, 'Sit') : null].filter(Boolean);
}

export const lockedMap = (ids, players, slate, now = Date.now()) =>
  Object.fromEntries(ids.filter(id => players[id]?.team && isLocked(players[id].team, slate, now)).map(id => [id, true]));

/**
 * Value over replacement: ROS points above the best player you could expect to
 * find on waivers at that position, given how many starters the league uses.
 * This is the "trade value" a manager perceives — a backup QB in a 1-QB league
 * is worth little even if he scores a lot.
 */
export function addVOR(values, players, league) {
  const teams = league.total_rosters || 12;
  const rp = league.roster_positions ?? [];
  const count = (s) => rp.filter(x => x === s).length;
  const flex = count('FLEX'), sf = count('SUPER_FLEX'), wrrb = count('WRRB_FLEX'), rec = count('REC_FLEX');
  const starters = {
    QB: count('QB') + sf * 0.9,
    RB: count('RB') + flex * 0.45 + wrrb * 0.5 + sf * 0.05,
    WR: count('WR') + flex * 0.45 + wrrb * 0.5 + rec * 0.7 + sf * 0.05,
    TE: count('TE') + flex * 0.1 + rec * 0.3,
    K: count('K'), DEF: count('DEF'),
  };
  const byPos = {};
  for (const v of Object.values(values)) (byPos[players[v.id]?.pos] ??= []).push(v);
  const replacement = {};
  for (const [pos, list] of Object.entries(byPos)) {
    list.sort((a, b) => b.ros - a.ros);
    const idx = Math.round(teams * (starters[pos] ?? 0));
    replacement[pos] = list[Math.min(idx, list.length - 1)]?.ros ?? 0;
    for (const v of list) v.vor = round1(Math.max(0, v.ros - replacement[pos]));
  }
  return replacement;
}

// Perceived trade value: surplus over replacement, plus a sliver of raw output.
// Kickers and defenses are streamed off waivers, so managers pay little for them.
export const TRADE_POS_WEIGHT = { K: 0.2, DEF: 0.3 };
export const tradeValue = (v) => (v ? ((v.vor ?? 0) + v.ros * 0.1) * (TRADE_POS_WEIGHT[v.pos] ?? 1) : 0);

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Greedy optimal lineup: fill the most restrictive slots first, each with the
 * best remaining eligible player. key: 'week' | 'ros' | 'rate'.
 */
export function optimalLineup(ids, rosterPositions, players, values, key = 'ros', opts = {}) {
  const fixed = opts.fixed ?? new Map();      // slot index -> player already locked into it
  const exclude = opts.exclude ?? new Set();  // players who cannot be moved into the lineup
  const fixedIds = new Set(fixed.values());
  const slots = rosterPositions
    .map((s, i) => ({ slot: s, i }))
    .filter(s => isStartingSlot(s.slot))
    .sort((a, b) => SLOT_ELIGIBILITY[a.slot].length - SLOT_ELIGIBILITY[b.slot].length || a.i - b.i);
  const all = ids
    .filter(id => players[id])
    .map(id => ({ id, pos: players[id].pos, v: values[id]?.[key] ?? 0 }))
    .sort((a, b) => b.v - a.v);
  const pool = all.filter(p => !exclude.has(p.id) && !fixedIds.has(p.id));
  const used = new Set();
  const filled = [];
  let total = 0;
  for (const s of slots) {
    const fid = fixed.get(s.i);
    if (fid && players[fid]) {
      const v = values[fid]?.[key] ?? 0;
      used.add(fid); total += v;
      filled.push({ slot: s.slot, i: s.i, id: fid, value: v, locked: true });
      continue;
    }
    const ok = SLOT_ELIGIBILITY[s.slot];
    const pick = pool.find(p => !used.has(p.id) && ok.includes(p.pos));
    if (pick) { used.add(pick.id); total += pick.v; }
    filled.push({ slot: s.slot, i: s.i, id: pick?.id ?? null, value: pick?.v ?? 0 });
  }
  filled.sort((a, b) => a.i - b.i);
  return { slots: filled, total: round1(total), starters: used, bench: all.filter(p => !used.has(p.id)).map(p => p.id) };
}

// Starters plus a little credit for depth (bye/injury insurance), so trades
// that consolidate or add depth register for both sides.
export function teamValue(ids, rosterPositions, players, values, key = 'ros') {
  const lu = optimalLineup(ids, rosterPositions, players, values, key);
  const depth = lu.bench.slice(0, 4).reduce((t, id) => t + (values[id]?.[key] ?? 0), 0);
  return round1(lu.total + depth * 0.15);
}

const rosterIds = (r) => (r.players ?? []).filter(id => !(r.reserve ?? []).includes(id) && !(r.taxi ?? []).includes(id));

// ---------- Start / sit ----------

export function startSit(roster, league, players, values, locked = {}) {
  const ids = rosterIds(roster);
  const current = (roster.starters ?? []);
  const startSlots = league.roster_positions.map((s, i) => ({ s, i })).filter(x => isStartingSlot(x.s));
  // A player whose game has started can't be benched, and a benched one can't be started.
  const fixed = new Map();
  startSlots.forEach((x, k) => { if (current[k] && locked[current[k]]) fixed.set(x.i, current[k]); });
  const exclude = new Set(ids.filter(id => locked[id] && ![...fixed.values()].includes(id)));
  const best = optimalLineup(ids, league.roster_positions, players, values, 'week', { fixed, exclude });
  const currentTotal = startSlots.reduce((t, _, k) => t + (values[current[k]]?.week ?? 0), 0);
  const currentSet = new Set(current);
  const moves = [];
  const toStart = best.slots.filter(s => s.id && !currentSet.has(s.id)).map(s => s.id);
  const toSit = current.filter(id => id && id !== '0' && !best.starters.has(id));
  toStart.sort((a, b) => (values[b]?.week ?? 0) - (values[a]?.week ?? 0));
  toSit.sort((a, b) => (values[a]?.week ?? 0) - (values[b]?.week ?? 0));
  for (let k = 0; k < Math.max(toStart.length, toSit.length); k++) {
    moves.push({ start: toStart[k] ?? null, sit: toSit[k] ?? null,
      gain: round1((values[toStart[k]]?.week ?? 0) - (values[toSit[k]]?.week ?? 0)) });
  }
  return { best, currentTotal: round1(currentTotal), gain: round1(best.total - currentTotal), moves, locked };
}

// ---------- Roster analysis ----------

export function analyzeLeague(rosters, league, players, values) {
  const teams = rosters.map(r => {
    const ids = rosterIds(r);
    const lu = optimalLineup(ids, league.roster_positions, players, values, 'ros');
    const byPos = {};
    for (const s of lu.slots) {
      if (!s.id) continue;
      const pos = players[s.id].pos;
      byPos[pos] = (byPos[pos] ?? 0) + s.value;
    }
    const benchRos = lu.bench.reduce((t, id) => t + (values[id]?.ros ?? 0), 0);
    return { rosterId: r.roster_id, ros: lu.total, weekly: optimalLineup(ids, league.roster_positions, players, values, 'week').total, byPos, benchRos: round1(benchRos), lineup: lu };
  });
  const rank = (arr, f) => [...arr].sort((a, b) => f(b) - f(a));
  rank(teams, t => t.ros).forEach((t, i) => (t.rank = i + 1));
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].filter(p => teams.some(t => t.byPos[p]));
  for (const pos of positions) {
    const sorted = rank(teams, t => t.byPos[pos] ?? 0);
    const median = sorted[Math.floor(sorted.length / 2)].byPos[pos] ?? 0;
    sorted.forEach((t, i) => {
      (t.posRank ??= {})[pos] = i + 1;
      (t.posVsMedian ??= {})[pos] = round1((t.byPos[pos] ?? 0) - median);
    });
  }
  return { teams, positions };
}

// ---------- Waivers & FAB ----------

export function freeAgentTargets(myRoster, rosters, league, players, values, { limit = 40 } = {}) {
  const owned = new Set(rosters.flatMap(r => r.players ?? []));
  const myIds = rosterIds(myRoster);
  const base = optimalLineup(myIds, league.roster_positions, players, values, 'ros');
  const baseWk = optimalLineup(myIds, league.roster_positions, players, values, 'week');
  const pool = Object.values(values)
    .filter(v => !owned.has(v.id) && players[v.id]?.team)
    .sort((a, b) => b.ros - a.ros)
    .slice(0, 150);
  const out = [];
  for (const fa of pool) {
    const withFa = [...myIds, fa.id];
    const lu = optimalLineup(withFa, league.roster_positions, players, values, 'ros');
    const gainRos = lu.total - base.total;
    const wk = optimalLineup(withFa, league.roster_positions, players, values, 'week');
    const gainWeek = wk.total - baseWk.total;
    if (gainRos <= 0.5 && gainWeek <= 0.5) continue;
    // Drop the bench player contributing least.
    const drop = lu.bench.filter(id => id !== fa.id).sort((a, b) => (values[a]?.ros ?? 0) - (values[b]?.ros ?? 0))[0] ?? null;
    const demand = rosters.filter(r => r.roster_id !== myRoster.roster_id).filter(r => {
      const ids = rosterIds(r);
      const b = optimalLineup(ids, league.roster_positions, players, values, 'ros').total;
      return optimalLineup([...ids, fa.id], league.roster_positions, players, values, 'ros').total - b > 1;
    }).length;
    const pos = players[fa.id].pos;
    out.push({ id: fa.id, pos, gainRos: round1(gainRos), gainWeek: round1(gainWeek), drop, demand,
      kind: gainRos >= 5 && !STREAMER_POS.has(pos) ? 'hold' : 'stream' });
  }
  const rank = (x) => (x.gainRos + x.gainWeek * 2) * (STREAMER_POS.has(x.pos) ? 0.4 : 1);
  out.sort((a, b) => rank(b) - rank(a));
  // A streaming list needs the best few defenses and kickers, not every one that beats yours.
  const seen = {};
  const trimmed = out.filter(x => {
    const cap = STREAMER_CAP[x.pos];
    if (cap == null) return true;
    seen[x.pos] = (seen[x.pos] ?? 0) + 1;
    return seen[x.pos] <= cap;
  });
  return trimmed.slice(0, limit);
}

// Positions that are streamed week to week rather than held.
const STREAMER_POS = new Set(['K', 'DEF']);
const STREAMER_CAP = { DEF: 3, K: 2 };

export const usesFab = (league) => league?.settings?.waiver_type === 2;

/**
 * Recommend a blind bid. Bid scales with the share of a typical starter's
 * rest-of-season output the pickup adds, how much season is left, and how many
 * other teams would also improve by adding him.
 */
export function fabBid(target, { budget, spent, week, numTeams, starterRos }) {
  const remaining = Math.max(0, budget - spent);
  if (!remaining) return { low: 0, rec: 0, high: 0, remaining, pctOfRemaining: 0 };
  const impact = Math.max(0, target.gainRos) / Math.max(starterRos, 1); // 0..~1
  const seasonLeft = remainingWeeks(week) / LAST_WEEK;
  const competition = 1 + 2 * Math.min(target.demand, numTeams) / Math.max(numTeams - 1, 1);
  let pct = impact * 0.6 * competition * (0.4 + 0.6 * seasonLeft);
  if (target.kind === 'stream') pct = Math.min(pct, 0.03 + target.gainWeek / 400);
  if (STREAMER_POS.has(target.pos)) pct = Math.min(pct, 0.02); // never spend real FAB on a kicker or defense
  pct = Math.min(pct, 0.6);
  const rec = Math.max(target.gainRos > 0 || target.gainWeek > 0 ? 1 : 0, Math.round(remaining * pct));
  return {
    low: Math.max(0, Math.round(rec * 0.6)),
    rec: Math.min(rec, remaining),
    high: Math.min(remaining, Math.round(rec * 1.4) + 1),
    remaining,
    pctOfRemaining: Math.round((rec / remaining) * 100),
  };
}

/**
 * Side-by-side case for a waiver target: where he would slot into your lineup, who he would bump,
 * who to compare him with, and plain-English reasons (matchup, game script, role, health).
 */
export function waiverComparison({ target, myRoster, league, players, values }) {
  const rp = league.roster_positions, ids = rosterIds(myRoster), tid = target.id;
  const run = (key) => {
    const before = optimalLineup(ids, rp, players, values, key);
    const after = optimalLineup([...ids, tid], rp, players, values, key);
    return {
      slot: after.slots.find(s => s.id === tid)?.slot ?? null,
      displaced: [...before.starters].find(id => !after.starters.has(id)) ?? null,
      gain: round1(after.total - before.total),
    };
  };
  const wk = run('week'), ros = run('ros');
  const samePos = ids.filter(id => players[id]?.pos === players[tid].pos && values[id]).sort((a, b) => values[b].ros - values[a].ros);

  const columns = [], roles = {};
  const add = (id, role) => {
    if (!id || id === tid || !values[id]) return;
    if (!columns.includes(id)) columns.push(id);
    (roles[id] ??= []).push(role);
  };
  add(ros.displaced, 'Bumped from your lineup'); add(wk.displaced, 'Bumped this week'); add(target.drop, 'Drop candidate');
  if (columns.length < 2) add(samePos[0], 'Your best at the position');
  if (!columns.length) add(samePos.at(-1), 'Your weakest at the position');
  columns.length = Math.min(columns.length, 2);

  const t = values[tid];
  const stepMult = (v, key) => v.breakdown.steps.find(x => x.key === key)?.mult ?? null;
  const reasons = [], caveats = [];
  // This-week reasons compare with who he'd bump this week; rest-of-season only with someone who is
  // actually a rest-of-season starter he'd displace (otherwise a "better ROS" line contradicts the gain).
  const refId = values[wk.displaced] ? wk.displaced : columns[0] ?? null;
  const ref = refId ? values[refId] : null;
  const refName = refId ? players[refId].name : null;
  if (ref) {
    const dW = round1(t.week - ref.week);
    if (Math.abs(dW) >= 0.5) reasons.push(`Projects ${f(t.week)} pts this week vs ${f(ref.week)} for ${refName} (${sgn(dW)}).`);
    const mt = stepMult(t, 'matchup'), mr = stepMult(ref, 'matchup');
    if (mt != null && mr != null && Math.abs(mt - mr) >= 0.04) reasons.push(mt > mr
      ? `Better matchup${t.opponent ? ` against ${t.opponent}` : ''} (${pct(mt - 1)} vs ${pct(mr - 1)} for ${refName}).`
      : `Tougher matchup than ${refName} this week (${pct(mt - 1)} vs ${pct(mr - 1)}).`);
    const et = t.breakdown.facts.env?.implied, er = ref.breakdown.facts.env?.implied;
    if (et != null && er != null && Math.abs(et - er) >= 2) reasons.push(et > er
      ? `His team is projected to score ${f(et)} vs ${f(er)} for ${refName}’s, so more scoring chances.`
      : `His team is projected for fewer points (${f(et)} vs ${f(er)}).`);
    const ut = t.breakdown.facts.usage, ur = ref.breakdown.facts.usage;
    const sT = ut?.snap?.l3, sR = ur?.snap?.l3;
    if (sT != null && sR != null && Math.abs(sT - sR) >= 0.08) reasons.push(sT > sR
      ? `Plays more: ${Math.round(sT * 100)}% of snaps over the last 3 games vs ${Math.round(sR * 100)}%.`
      : `Plays less: ${Math.round(sT * 100)}% of snaps vs ${Math.round(sR * 100)}%.`);
    const gT = ut && ut.snap.season ? ut.snap.l3 / ut.snap.season - 1 : null;
    if (gT != null && gT >= 0.12) reasons.push(`His role is growing (snaps up ${Math.round(gT * 100)}% vs his season average).`);
    const injR = players[refId].injury, injT = players[tid].injury;
    if (injR && !injT) reasons.push(`${refName} is ${injR}${players[refId].injuryNote ? ` (${players[refId].injuryNote})` : ''}; ${players[tid].name} is healthy.`);
    if (ref.week === 0 && t.week > 0 && !injR) reasons.push(`${refName} is not expected to play this week.`);
  }
  const refR = ros.gain > 0.5 && ros.displaced && values[ros.displaced] ? ros.displaced : null;
  if (refR) {
    const r = values[refR];
    reasons.push(`Over the rest of the season he projects ${f(t.ros)} pts vs ${f(r.ros)} for ${players[refR].name} (${sgn(round1(t.ros - r.ros))}), ${f(t.rate)} vs ${f(r.rate)} per game.`);
  }
  const ex = t.breakdown.facts.expert;
  if (ex) reasons.push(`Experts rank him ${players[tid].pos}${ex.posRank}${ex.ranks?.length > 1 ? ` (average of ${ex.ranks.length} sources)` : ''}.`);

  if (players[tid].injury) caveats.push(`He is listed ${players[tid].injury}${players[tid].injuryNote ? ` (${players[tid].injuryNote})` : ''}.`);
  if (t.week === 0) caveats.push('He is not projected to play this week (bye or injury).');
  if (ros.gain <= 0.5 && wk.gain > 0.5) caveats.push('This is a one-week streaming move; he doesn’t improve your rest-of-season outlook.');
  if (!wk.slot && !ros.slot) caveats.push('He would not crack your starting lineup; this is a depth or upside add.');

  return { slotWeek: wk.slot, slotRos: ros.slot, displacedWeek: wk.displaced, displacedRos: ros.displaced,
    gainWeek: wk.gain, gainRos: ros.gain, columns, roles, reasons, caveats };
}
const f = (n) => (Math.round((n ?? 0) * 10) / 10).toFixed(1);
const sgn = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;
const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}%`;

// ---------- Trades ----------

function afterTrade(ids, give, get, rosterSize, values) {
  const next = ids.filter(id => !give.includes(id)).concat(get);
  // Receiving more than you send forces drops of your least valuable players.
  while (rosterSize && next.length > rosterSize) {
    next.sort((a, b) => (values[a]?.ros ?? 0) - (values[b]?.ros ?? 0));
    next.shift();
  }
  return next;
}

export function evaluateTrade({ myRoster, theirRoster, give, get, league, players, values, week }) {
  const myIds = rosterIds(myRoster);
  const theirIds = rosterIds(theirRoster);
  const size = Math.max(myIds.length, theirIds.length);
  const rp = league.roster_positions;
  const lu = (ids, key) => teamValue(ids, rp, players, values, key);
  const myAfter = afterTrade(myIds, give, get, size, values);
  const theirAfter = afterTrade(theirIds, get, give, size, values);
  const myDelta = round1(lu(myAfter, 'ros') - lu(myIds, 'ros'));
  const theirDelta = round1(lu(theirAfter, 'ros') - lu(theirIds, 'ros'));
  const myWeek = round1(lu(myAfter, 'week') - lu(myIds, 'week'));
  const sum = (arr) => arr.reduce((t, id) => t + tradeValue(values[id]), 0);
  const giveVal = round1(sum(give));
  const getVal = round1(sum(get));
  const weeks = Math.max(remainingWeeks(week), 1);
  const perWeek = round1(myDelta / weeks);
  // How likely the other manager says yes. Most managers judge trades on raw
  // player value ("am I getting more?") more than on their own lineup fit.
  const parity = getVal ? giveVal / getVal : 2;
  let accept = 0.45 + Math.tanh(theirDelta / 40) * 0.2 + Math.tanh((parity - 1) * 3) * 0.35;
  accept = Math.max(0.02, Math.min(0.98, accept));
  return { myDelta, theirDelta, myWeek, perWeek, giveVal, getVal, accept: Math.round(accept * 100), grade: gradeFor(perWeek, accept) };
}

export function gradeFor(perWeek, accept = 0.5) {
  const score = perWeek + (accept < 0.25 ? -0.75 : 0);
  if (score >= 3) return 'A+';
  if (score >= 2) return 'A';
  if (score >= 1.25) return 'A-';
  if (score >= 0.75) return 'B+';
  if (score >= 0.35) return 'B';
  if (score >= 0) return 'C';
  if (score >= -1) return 'D';
  return 'F';
}

export function suggestTrades({ myRoster, rosters, league, players, values, week, limit = 12 }) {
  const top = (r, n) => rosterIds(r).filter(id => values[id] && !['K', 'DEF'].includes(players[id]?.pos)).sort((a, b) => values[b].ros - values[a].ros).slice(0, n);
  const mine = top(myRoster, 14);
  const results = [];
  for (const them of rosters) {
    if (them.roster_id === myRoster.roster_id) continue;
    const theirs = top(them, 12);
    const offers = [];
    for (const g of mine) for (const t of theirs) offers.push([[g], [t]]);
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) for (const t of theirs) offers.push([[mine[i], mine[j]], [t]]);
    for (const [give, get] of offers) {
      const e = evaluateTrade({ myRoster, theirRoster: them, give, get, league, players, values, week });
      if (e.myDelta > 2 && e.giveVal >= e.getVal * 0.95 && e.accept >= 40 && e.theirDelta > -Math.max(15, e.myDelta * 1.5)) results.push({ rosterId: them.roster_id, give, get, ...e });
    }
  }
  // Rank by expected value of offering it, then keep variety across partners/players.
  results.sort((a, b) => b.myDelta * b.accept - a.myDelta * a.accept);
  const out = [];
  const perTeam = {};
  const usedGet = new Set();
  for (const r of results) {
    if ((perTeam[r.rosterId] ?? 0) >= 2 || usedGet.has(r.get.join())) continue;
    perTeam[r.rosterId] = (perTeam[r.rosterId] ?? 0) + 1;
    usedGet.add(r.get.join());
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
