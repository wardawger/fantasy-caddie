// Pure analytics: projections → player values → lineups, waivers, FAB, trades.
// No DOM or network here so it can be unit-tested in Node.

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
  const allowed = {}; // team -> pos -> [sum, n]
  const posTotal = {};
  for (const wk of weeklyStats) {
    for (const [id, row] of Object.entries(wk)) {
      const p = players[id];
      if (!p || !row.opponent) continue;
      const pts = fantasyPoints(row.stats, scoring);
      if (pts <= 0 && !row.stats?.gp) continue;
      const a = ((allowed[row.opponent] ??= {})[p.pos] ??= [0, 0]);
      a[0] += pts; a[1] += 1;
      const t = (posTotal[p.pos] ??= [0, 0]);
      t[0] += pts; t[1] += 1;
    }
  }
  const out = {};
  for (const [team, byPos] of Object.entries(allowed)) {
    out[team] = {};
    for (const [pos, [sum, n]] of Object.entries(byPos)) {
      const avg = posTotal[pos][0] / posTotal[pos][1];
      if (!avg) continue;
      const raw = (sum / n) / avg;
      const trust = Math.min(n / (weeklyStats.length * 3 || 1), 1) * 0.5;
      out[team][pos] = 1 + (raw - 1) * trust;
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
  const out = {};
  for (const p of Object.values(players)) {
    const wp = ctx.weekProj?.[p.id];
    const sp = ctx.seasonProj?.[p.id];
    const st = ctx.seasonStats?.[p.id];
    const projGames = sp?.stats?.gp || 17;
    const projRate = sp ? fantasyPoints(sp.stats, scoring) / projGames : 0;
    const actualRate = st?.games ? st.pts / st.games : null;
    const wkPts = wp ? fantasyPoints(wp.stats, scoring) : null;

    // Blend preseason/ROS projection with realised production as games accrue.
    let rate = projRate;
    if (actualRate != null) {
      const w = Math.min(st.games, 8) / 16;
      rate = projRate ? projRate * (1 - w) + actualRate * w : actualRate;
    }
    if (!rate && wkPts) rate = wkPts;
    if (!rate) continue;

    const notes = [];
    const inj = INJURY[p.injury];
    const bye = ctx.byes?.[p.team];
    const onBye = bye === week;
    let games = remWeeks - (bye != null && bye >= week ? 1 : 0);
    if (inj) games = Math.max(0, games - inj.gamesLost);
    if (!p.team && p.pos !== 'DEF') games = 0;

    let wk = wkPts ?? rate;
    if (onBye) { wk = 0; notes.push({ kind: 'bye', text: 'On bye this week' }); }
    if (inj) {
      wk *= inj.week;
      notes.push({ kind: 'injury', text: `${p.injury}${p.injuryNote ? ` · ${p.injuryNote}` : ''}` });
    }
    const opp = wp?.opponent ?? null;
    const dvp = opp ? ctx.dvp?.[opp]?.[p.pos] : null;
    if (dvp && !onBye) {
      wk *= dvp;
      if (dvp >= 1.06) notes.push({ kind: 'matchup', good: true, text: `Soft matchup vs ${opp} (+${Math.round((dvp - 1) * 100)}%)` });
      else if (dvp <= 0.94) notes.push({ kind: 'matchup', good: false, text: `Tough matchup vs ${opp} (${Math.round((dvp - 1) * 100)}%)` });
    }
    const wx = ctx.weather?.[p.team];
    if (wx && !onBye) {
      const m = weatherMultiplier(p.pos, wx);
      wk *= m;
      if (Math.abs(m - 1) >= 0.02) notes.push({ kind: 'weather', good: m > 1, text: `${wx.summary} (${m > 1 ? '+' : ''}${Math.round((m - 1) * 100)}%)` });
    }

    out[p.id] = {
      id: p.id,
      week: round1(wk),
      rawWeek: wkPts == null ? null : round1(wkPts),
      rate: round1(rate),
      ros: round1(rate * Math.max(0, games)),
      notes,
      opponent: opp,
    };
  }
  return out;
}

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
export const tradeValue = (v) => (v ? (v.vor ?? 0) + v.ros * 0.1 : 0);

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Greedy optimal lineup: fill the most restrictive slots first, each with the
 * best remaining eligible player. key: 'week' | 'ros' | 'rate'.
 */
export function optimalLineup(ids, rosterPositions, players, values, key = 'ros') {
  const slots = rosterPositions
    .map((s, i) => ({ slot: s, i }))
    .filter(s => isStartingSlot(s.slot))
    .sort((a, b) => SLOT_ELIGIBILITY[a.slot].length - SLOT_ELIGIBILITY[b.slot].length || a.i - b.i);
  const pool = ids
    .filter(id => players[id])
    .map(id => ({ id, pos: players[id].pos, v: values[id]?.[key] ?? 0 }))
    .sort((a, b) => b.v - a.v);
  const used = new Set();
  const filled = [];
  let total = 0;
  for (const s of slots) {
    const ok = SLOT_ELIGIBILITY[s.slot];
    const pick = pool.find(p => !used.has(p.id) && ok.includes(p.pos));
    if (pick) { used.add(pick.id); total += pick.v; }
    filled.push({ slot: s.slot, i: s.i, id: pick?.id ?? null, value: pick?.v ?? 0 });
  }
  filled.sort((a, b) => a.i - b.i);
  return { slots: filled, total: round1(total), starters: used, bench: pool.filter(p => !used.has(p.id)).map(p => p.id) };
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

export function startSit(roster, league, players, values) {
  const ids = rosterIds(roster);
  const best = optimalLineup(ids, league.roster_positions, players, values, 'week');
  const current = (roster.starters ?? []);
  const startSlots = league.roster_positions.map((s, i) => ({ s, i })).filter(x => isStartingSlot(x.s));
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
  return { best, currentTotal: round1(currentTotal), gain: round1(best.total - currentTotal), moves };
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
    out.push({ id: fa.id, gainRos: round1(gainRos), gainWeek: round1(gainWeek), drop, demand,
      kind: gainRos >= 5 ? 'hold' : 'stream' });
  }
  out.sort((a, b) => (b.gainRos + b.gainWeek * 2) - (a.gainRos + a.gainWeek * 2));
  return out.slice(0, limit);
}

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
  const top = (r, n) => rosterIds(r).filter(id => values[id]).sort((a, b) => values[b].ros - values[a].ros).slice(0, n);
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
