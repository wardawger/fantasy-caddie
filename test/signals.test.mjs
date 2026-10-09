import assert from 'node:assert/strict';
import test from 'node:test';
import * as S from '../js/signals.js';
import * as E from '../js/engine.js';
import { demoContext } from '../js/demo.js';
import { finish } from '../js/data.js';

// Shapes match ESPN's public scoreboard/news JSON.
const scoreboard = { events: [
  { date: '2026-10-11T17:00Z', status: { type: { state: 'pre' } }, competitions: [{ venue: { indoor: false },
    competitors: [{ homeAway: 'home', team: { abbreviation: 'KC' } }, { homeAway: 'away', team: { abbreviation: 'WSH' } }],
    odds: [{ details: 'KC -7.5', overUnder: 48.5, spread: -7.5 }] }] },
  { date: '2026-10-08T00:20Z', status: { type: { state: 'post' } }, competitions: [{ venue: { indoor: true },
    competitors: [{ homeAway: 'home', team: { abbreviation: 'DET' } }, { homeAway: 'away', team: { abbreviation: 'GB' } }],
    odds: [{ details: 'EVEN', overUnder: 50 }] }] },
] };

test('scoreboard → slate with implied totals, aliases and lock state', () => {
  const games = S.parseScoreboard(scoreboard);
  assert.equal(games.length, 2);
  const slate = S.buildSlate(games);
  assert.equal(slate.WAS.opp, 'KC');                 // WSH → WAS
  assert.equal(slate.KC.implied, 28);                // (48.5 + 7.5) / 2
  assert.equal(slate.WAS.implied, 20.5);
  assert.equal(slate.KC.margin, 7.5);
  assert.equal(slate.WAS.margin, -7.5);
  assert.equal(slate.DET.implied, 25);               // pick'em
  const now = Date.parse('2026-10-11T12:00Z');
  assert.equal(S.isLocked('KC', slate, now), false);
  assert.equal(S.isLocked('KC', slate, Date.parse('2026-10-11T17:05Z')), true); // past kickoff even if state is stale
  assert.equal(S.isLocked('GB', slate, now), true);  // final
  assert.equal(S.isLocked('NYJ', slate, now), false); // not on slate
});

test('odds fall back to spread + homeTeamOdds when details are missing', () => {
  const o = S.parseOdds({ overUnder: 44, spread: -3, homeTeamOdds: { favorite: false } },
    { competitors: [{ homeAway: 'home', team: { abbreviation: 'NE' } }, { homeAway: 'away', team: { abbreviation: 'BUF' } }] });
  assert.deepEqual(o, { total: 44, margin: 3, favorite: 'BUF' });
  assert.deepEqual(S.parseOdds(null), { total: null, margin: null, favorite: null });
});

test('Vegas multiplier rewards shootouts and punishes low totals, bounded', () => {
  const hi = { implied: 30, oppImplied: 18, margin: 10 }, lo = { implied: 15, oppImplied: 30, margin: -10 };
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K']) {
    assert.ok(S.vegasMultiplier(pos, hi) > 1, pos);
    assert.ok(S.vegasMultiplier(pos, lo) < 1, pos);
  }
  assert.ok(S.vegasMultiplier('DEF', { implied: 20, oppImplied: 15 }) > 1);   // opponent expected to score little
  assert.ok(S.vegasMultiplier('DEF', { implied: 20, oppImplied: 30 }) < 1);
  assert.ok(S.vegasMultiplier('WR', { implied: 99, margin: 99 }) <= 1.12);
  assert.equal(S.vegasMultiplier('WR', null), 1);
});

test('snap/target share come from team-relative weekly stats; trend moves projection', () => {
  const players = { a: { id: 'a', pos: 'WR', team: 'KC' }, b: { id: 'b', pos: 'WR', team: 'KC' } };
  const week = (aTgt, bTgt, aSnap) => ({
    a: { team: 'KC', stats: { off_snp: aSnap, tm_off_snp: 70, rec_tgt: aTgt } },
    b: { team: 'KC', stats: { off_snp: 50, tm_off_snp: 70, rec_tgt: bTgt } },
  });
  const weekly = [week(4, 6, 40), week(4, 6, 40), week(4, 6, 40), week(8, 2, 60), week(8, 2, 62), week(8, 2, 64)];
  const u = S.buildUsage(weekly, players);
  assert.equal(u.a.games, 6);
  assert.ok(Math.abs(u.a.tgt.l3 - 0.8) < 1e-9);                        // 8 of 10 team targets
  assert.ok(Math.abs(u.a.tgt.season - 0.6) < 1e-9);                    // (0.4×3 + 0.8×3) / 6
  assert.ok(u.a.snap.l3 > u.a.snap.season);
  const up = S.usageMultiplier('WR', u.a), down = S.usageMultiplier('WR', u.b);
  assert.ok(up.mult > 1 && up.mult <= 1.1);
  assert.ok(down.mult < 1 && down.mult >= 0.9);
  assert.equal(S.usageMultiplier('WR', { ...u.a, games: 3 }).mult, 1);  // too little data
});

const csv = `"RK","TIER","PLAYER NAME","TEAM","POS","OPP","ECR"
"1","1","Patrick Mahomes II","KC","QB1","WAS","1.2"
"2","1","CeeDee Lamb","DAL","WR1","NYG","2.0"
"3","2","Kansas City Chiefs","KC","DST1","WAS","3"
"4","2","Amon-Ra St. Brown","DET","WR2","GB","4"
`;
test('FantasyPros-style CSV parses, including quotes, suffixes and DST', () => {
  const rows = S.parseRankingsCSV(csv);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { name: 'Patrick Mahomes II', team: 'KC', pos: 'QB', rank: 1, posRank: 1 });
  assert.equal(rows[2].pos, 'DEF');
  const players = { 1: { id: '1', name: 'Patrick Mahomes', pos: 'QB', team: 'KC' }, 2: { id: '2', name: 'Amon-Ra St Brown', pos: 'WR', team: 'DET' },
    3: { id: '3', name: 'Kansas City Defense', pos: 'DEF', team: 'KC' }, 4: { id: '4', name: 'Someone Else', pos: 'WR', team: 'DET' } };
  const { map, unmatched } = S.matchRankings(rows, players);
  assert.deepEqual(Object.keys(map).sort(), ['1', '2', '3']);
  assert.equal(map['2'].posRank, 2);
  assert.equal(unmatched, 1);                                           // CeeDee isn't in this tiny pool
  assert.deepEqual(S.parseRankingsCSV('garbage'), []);
  // Only overall rank given → positional rank derived.
  const r2 = S.parseRankingsCSV('Rank,Name,Team,Position\n1,A B,KC,WR\n2,C D,KC,RB\n3,E F,KC,WR');
  assert.deepEqual(r2.map(r => r.posRank), [1, 1, 2]);
});

test('news maps ESPN athlete ids to Sleeper players and ignores stale items', () => {
  const items = S.parseNews({ articles: [
    { headline: 'A ruled out', published: '2026-10-08T10:00:00Z', categories: [{ type: 'athlete', athleteId: 111 }, { type: 'team', teamId: 1 }] },
    { headline: 'Old', published: '2026-09-01T10:00:00Z', categories: [{ type: 'athlete', athleteId: 111 }] },
    { headline: 'No athlete', categories: [] },
  ] });
  assert.equal(items.length, 2);
  const out = S.newsByPlayer(items, { p1: { id: 'p1', espnId: 111 } }, Date.parse('2026-10-09T00:00Z'));
  assert.deepEqual(out.p1.map(n => n.headline), ['A ruled out']);
});

// ---- engine integration on the sample league
const fresh = () => demoContext();

test('every projection breakdown adds up: base → steps → final', () => {
  const c = fresh();
  for (const v of Object.values(c.values)) {
    const b = v.breakdown;
    let run = b.base;
    for (const s of b.steps) { assert.ok(Math.abs(s.after - (run + s.delta)) < 0.25, `${v.id} ${s.key}`); run = s.after; }
    assert.ok(Math.abs(b.final - v.week) < 0.11);
    assert.ok(Math.abs(run - b.final) < 0.11);
  }
});

test('Vegas, usage and matchup steps show up and move the projection', () => {
  const c = fresh();
  const keys = new Set(Object.values(c.values).flatMap(v => v.breakdown.steps.map(s => s.key)));
  for (const k of ['bye', 'injury', 'matchup', 'usage', 'vegas', 'weather']) assert.ok(keys.has(k), k);
});

test('expert rank blends toward the points a rank is worth, and never revives Out/bye players', () => {
  const c = fresh();
  const wr = Object.values(c.players).filter(p => p.pos === 'WR' && c.values[p.id] && !p.injury && c.slate[p.team]);
  const lowWR = wr.sort((a, b) => c.values[a.id].week - c.values[b.id].week)[0];
  const before = c.values[lowWR.id].week;
  const out = Object.values(c.players).find(p => p.injury === 'Out' && c.values[p.id]);
  c.expertWeight = 0.4;
  c.expertSets = [{ id: 'x', name: 'X', week: c.week, rows: [
    { name: lowWR.name, team: lowWR.team, pos: 'WR', rank: 1, posRank: 1 },
    { name: out.name, team: out.team, pos: out.pos, rank: 1, posRank: 1 },
  ] }];
  finish(c);
  assert.ok(c.values[lowWR.id].week > before + 1, `${before} → ${c.values[lowWR.id].week}`);
  assert.ok(c.values[lowWR.id].breakdown.steps.some(s => s.key === 'expert'));
  assert.equal(c.values[out.id].week, 0);
  c.expertSets[0].week = c.week + 1; finish(c);                                  // wrong week → ignored
  assert.equal(c.values[lowWR.id].week, before);
});

test('locked players stay put: started starters are fixed, started bench players cannot be started', () => {
  const c = fresh();
  const me = c.rosters[0];
  const cur = me.starters;
  const worst = cur.filter(Boolean).sort((a, b) => c.values[a].week - c.values[b].week)[0];
  const bestBench = me.players.filter(id => !cur.includes(id)).sort((a, b) => c.values[b].week - c.values[a].week)[0];
  const free = E.startSit(me, c.league, c.players, c.values, {});
  // Lock the weak starter (already played) and the strong bench player (already played).
  const locked = { [worst]: true, [bestBench]: true };
  const res = E.startSit(me, c.league, c.players, c.values, locked);
  assert.ok(res.best.starters.has(worst), 'locked starter must remain');
  assert.ok(!res.best.starters.has(bestBench), 'locked bench player cannot enter');
  assert.ok(res.best.slots.find(s => s.id === worst).locked);
  assert.ok(res.best.total <= free.best.total + 1e-9);
  for (const m of res.moves) { assert.notEqual(m.sit, worst); assert.notEqual(m.start, bestBench); }
  assert.ok(Object.keys(E.lockedMap(me.players, c.players, c.slate)).length > 0);
});

test('explainMove names both players with base → final and top factors', () => {
  const c = fresh();
  const [a, b] = c.rosters[0].players.filter(id => c.values[id]);
  const lines = E.explainMove(a, b, c.values, c.players);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Start .+: \d+\.\d → \d+\.\d pts/);
  assert.match(lines[1], /^Sit /);
});
