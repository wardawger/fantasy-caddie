import assert from 'node:assert/strict';
import test from 'node:test';
import * as R from '../js/rankingSources.js';
import { aggregateRankings } from '../js/signals.js';
import { demoContext } from '../js/demo.js';
import { finish } from '../js/data.js';

// Fixtures follow each site's data shape as documented in the source comments.
const fpHtml = `<html><script>var ecrData = {"sport":"NFL","players":[
 {"player_name":"Ja'Marr Chase","player_team_id":"CIN","player_position_id":"WR","rank_ecr":1,"pos_rank":"WR1"},
 {"player_name":"Bijan Robinson","player_team_id":"ATL","player_position_id":"RB","rank_ecr":2,"pos_rank":"RB1"},
 {"player_name":"Bills","player_team_id":"BUF","player_position_id":"DST","rank_ecr":3,"pos_rank":"DST1"},
 {"player_name":"Brace; {tricky} \\"quote\\"","player_team_id":"WSH","player_position_id":"TE","rank_ecr":4,"pos_rank":"TE1"}
 ],"note":"x;"}; var other = 1;</script></html>`;
const cbsHtml = `<div class="player-row"><span class="CellPlayerName--long"><span><span class="CellPlayerName-name"><a href="/x">Josh Allen</a></span><span class="CellPlayerName-position"> QB </span><span class="CellPlayerName-team">BUF</span></span></span></div>
<div class="player-row"><span class="CellPlayerName--long"><span><span class="CellPlayerName-name"><a href="/y">Lamar Jackson</a></span><span class="CellPlayerName-position">QB</span><span class="CellPlayerName-team">BAL</span></span></span></div>`;
const dsHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { rankings: Array.from({ length: 25 }, (_, i) => ({ name: `Player ${i}`, position: i % 2 ? 'RB' : 'WR', team: 'KC', rank: i + 1 })) } } })}</script>`;
const ffcJson = JSON.stringify({ status: 'Success', players: [
  { name: 'Christian McCaffrey', position: 'RB', team: 'SF', adp: 1.4 }, { name: 'Tyreek Hill', position: 'WR', team: 'MIA', adp: 2.1 },
  { name: 'Justin Jefferson', position: 'WR', team: 'MIN', adp: 2.9 }, { name: 'Dallas Cowboys', position: 'DEF', team: 'DAL', adp: 80 } ] });

test('FantasyPros parser reads ecrData even with braces/semicolons/quotes in strings', () => {
  const rows = R.parseFantasyPros(fpHtml);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { name: "Ja'Marr Chase", team: 'CIN', pos: 'WR', rank: 1, posRank: 1 });
  assert.equal(rows[2].pos, 'DEF');
  assert.equal(rows[3].team, 'WAS');
  assert.throws(() => R.parseFantasyPros('<html>nothing</html>'), /not found/);
});
test('CBS parser reads name/position/team cells in order', () => {
  const rows = R.parseCBS(cbsHtml, 'QB');
  assert.deepEqual(rows.map(r => [r.name, r.pos, r.team, r.posRank]), [['Josh Allen', 'QB', 'BUF', 1], ['Lamar Jackson', 'QB', 'BAL', 2]]);
  assert.throws(() => R.parseCBS('<div></div>', 'QB'), /no ranking rows/);
});
test('Draft Sharks parser finds the player array inside embedded app data, or says why not', () => {
  const rows = R.parseDraftSharks(dsHtml);
  assert.equal(rows.length, 25);
  assert.equal(rows[0].posRank, 1); assert.equal(rows[1].pos, 'RB'); assert.equal(rows[1].posRank, 1);
  assert.throws(() => R.parseDraftSharks('<html>Log in to see rankings</html>'), /premium|client-side/);
});
test('FFC parser converts ADP order into positional ranks', () => {
  const rows = R.parseFFC(ffcJson);
  assert.deepEqual(rows.filter(r => r.pos === 'WR').map(r => r.posRank), [1, 2]);
  assert.equal(rows.find(r => r.name === 'Dallas Cowboys').pos, 'DEF');
});

test('league settings choose the matching ranking pages', () => {
  const half = R.leagueProfile({ scoring_settings: { rec: 0.5 }, roster_positions: ['QB', 'RB', 'WR', 'FLEX', 'K', 'DEF', 'BN'], total_rosters: 12 });
  assert.deepEqual([half.scoring, half.superflex, half.teams], ['half', false, 12]);
  assert.equal(half.label, 'Half-PPR · 1-QB · 12 teams');
  const url = (src, p, ctx = { season: '2026' }) => src.plan(p, ctx).flatMap(i => i.candidates);
  const [fp, cbs, ds, ffc] = R.SOURCES;
  assert.deepEqual(url(fp, half), ['https://www.fantasypros.com/nfl/rankings/half-point-ppr-flex.php', 'https://www.fantasypros.com/nfl/rankings/qb.php', 'https://www.fantasypros.com/nfl/rankings/k.php', 'https://www.fantasypros.com/nfl/rankings/dst.php']);
  const sf = R.leagueProfile({ scoring_settings: { rec: 1, bonus_rec_te: 0.5 }, roster_positions: ['QB', 'RB', 'WR', 'SUPER_FLEX', 'BN'], total_rosters: 10 });
  assert.deepEqual([sf.scoring, sf.superflex, sf.tePremium, sf.hasK], ['ppr', true, true, false]);
  assert.deepEqual(url(fp, sf), ['https://www.fantasypros.com/nfl/rankings/ppr-superflex.php']);   // no QB/K/DST pages needed
  assert.ok(url(ffc, sf)[0].includes('/adp/2qb?teams=10&year=2026'));
  assert.ok(url(ffc, half)[0].includes('/adp/half-ppr?teams=12'));
  assert.ok(url(cbs, { ...half, scoring: 'std' }).some(u => u.includes('/standard/QB/')));
  assert.ok(url(ds, sf)[0].includes('superflex'));
  const std = R.leagueProfile({ scoring_settings: { rec: 0 }, roster_positions: ['QB', 'QB', 'RB'] });
  assert.equal(std.scoring, 'std'); assert.equal(std.superflex, true);  // two QB slots ⇒ treat as 2-QB
});

test('loadSource tries fallbacks, survives failures and reports per-URL status', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes('/ppr/QB/') && !url.includes('weekly')) return { ok: false, status: 404, text: async () => '' };
    if (url.includes('/ppr/QB/weekly/')) return { ok: true, status: 200, text: async () => cbsHtml };
    return { ok: false, status: 403, text: async () => 'blocked' };
  };
  const profile = { scoring: 'ppr', superflex: false, teams: 12, hasK: true, hasDef: true };
  const out = await R.loadSource(R.SOURCES[1], profile, { season: '2026' }, fakeFetch);
  assert.equal(out.rows.length, 2);
  assert.equal(out.error, null);
  assert.ok(out.tried.some(t => t.ok && t.url.endsWith('/ppr/QB/weekly/')));
  assert.ok(out.tried.some(t => !t.ok && t.error === 'HTTP 404'));
  const dead = await R.loadSource(R.SOURCES[0], profile, { season: '2026' }, async () => { throw new Error('boom'); });
  assert.deepEqual([dead.rows.length, dead.error], [0, 'boom']);
});

test('aggregation averages positional ranks across sources by weight and keeps each source’s number', () => {
  const players = { a: { id: 'a', name: 'Ja\'Marr Chase', pos: 'WR', team: 'CIN' }, b: { id: 'b', name: 'Only One', pos: 'RB', team: 'KC' } };
  const sets = [
    { id: 'fp', name: 'FP', weight: 1, rows: [{ name: "Ja'Marr Chase", team: 'CIN', pos: 'WR', rank: 1, posRank: 1 }, { name: 'Only One', team: 'KC', pos: 'RB', rank: 9, posRank: 4 }] },
    { id: 'cbs', name: 'CBS', weight: 1, rows: [{ name: "Ja'Marr Chase", team: 'CIN', pos: 'WR', rank: 3, posRank: 3 }] },
    { id: 'ffc', name: 'FFC', weight: 0.5, rows: [{ name: "Ja'Marr Chase", team: 'CIN', pos: 'WR', rank: 6, posRank: 6 }] },
  ];
  const { map, perSource } = aggregateRankings(sets, players);
  assert.equal(map.a.n, 3);
  assert.equal(map.a.posRank, 2.8);                   // (1 + 3 + 6×0.5) / 2.5
  assert.deepEqual(map.a.ranks.map(r => r.posRank), [1, 3, 6]);
  assert.equal(map.b.posRank, 4);
  assert.deepEqual(perSource.map(x => x.matched), [2, 1, 1]);
});

test('fractional aggregate ranks interpolate between neighbouring rank values', () => {
  const c = demoContext();
  const wr = Object.values(c.players).filter(p => p.pos === 'WR' && c.values[p.id] && !p.injury && c.slate[p.team]).sort((a, b) => c.values[b.id].week - c.values[a.id].week);
  const p = wr[30];
  const mk = (rank) => { c.expertWeight = 0.5; c.expertSets = [{ id: 's', name: 'S', week: c.week, rows: [{ name: p.name, team: p.team, pos: 'WR', rank, posRank: rank }] }]; finish(c); return c.values[p.id].breakdown.facts.expert.pts; };
  const a = mk(5), b = mk(6), mid = (() => { c.expertSets = [{ id: 's', name: 'S', week: c.week, rows: [{ name: p.name, team: p.team, pos: 'WR', rank: 5.5, posRank: 5.5 }] }]; finish(c); return c.values[p.id].breakdown.facts.expert.pts; })();
  assert.ok(a >= b && mid <= a && mid >= b, `${a} ${mid} ${b}`);
});
