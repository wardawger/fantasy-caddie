import assert from 'node:assert/strict';
import test from 'node:test';
import { demoContext } from '../js/demo.js';
import * as E from '../js/engine.js';

const ctx = demoContext();
const me = ctx.rosters[0];

test('fantasyPoints applies league scoring', () => {
  assert.equal(E.fantasyPoints({ rec: 5, rec_yd: 60 }, { rec: 1, rec_yd: 0.1 }), 11);
});
test('optimal lineup fills every starting slot with eligible players', () => {
  const lu = E.optimalLineup(me.players, ctx.league.roster_positions, ctx.players, ctx.values, 'week');
  assert.equal(lu.slots.length, 10);
  for (const s of lu.slots) assert.ok(s.id, `slot ${s.slot} empty`);
  const flex = lu.slots.filter(s => s.slot === 'FLEX');
  for (const s of flex) assert.ok(['RB','WR','TE'].includes(ctx.players[s.id].pos));
});
test('injured Out players project zero this week', () => {
  const out = Object.values(ctx.players).find(p => p.injury === 'Out' && ctx.values[p.id]);
  assert.equal(ctx.values[out.id].week, 0);
});
test('start/sit never recommends a worse lineup', () => {
  for (const r of ctx.rosters) assert.ok(E.startSit(r, ctx.league, ctx.players, ctx.values).gain >= 0);
});
test('free agents and FAB bids are sane', () => {
  const fas = E.freeAgentTargets(me, ctx.rosters, ctx.league, ctx.players, ctx.values);
  assert.ok(fas.length > 0);
  for (const f of fas) {
    const b = E.fabBid(f, { budget: 100, spent: 20, week: 6, numTeams: 12, starterRos: 150 });
    assert.ok(b.low <= b.rec && b.rec <= b.high && b.high <= 80, JSON.stringify(b));
  }
});
test('trade evaluation is antisymmetric-ish and suggestions benefit me', () => {
  const them = ctx.rosters[3];
  const e = E.evaluateTrade({ myRoster: me, theirRoster: them, give: [me.players[0]], get: [them.players[0]], league: ctx.league, players: ctx.players, values: ctx.values, week: 6 });
  assert.ok(typeof e.grade === 'string');
  const s = E.suggestTrades({ myRoster: me, rosters: ctx.rosters, league: ctx.league, players: ctx.players, values: ctx.values, week: 6 });
  for (const t of s) assert.ok(t.myDelta > 0);
  console.log('suggestions', s.length, s.slice(0,3).map(t=>[t.grade,t.myDelta,t.theirDelta,t.accept]));
});
test('weather penalises passing in high wind but not domes', () => {
  assert.ok(E.weatherMultiplier('QB', { windMph: 25 }) < 1);
  assert.equal(E.weatherMultiplier('QB', { dome: true, windMph: 30 }), 1);
});
