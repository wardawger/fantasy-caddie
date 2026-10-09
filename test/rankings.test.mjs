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
const cbsRow = (rank, first, init, last, team, pos, opp = '@ARI') => `<tr class="FightTable-row FantasyRankingsTable-row"><td class="FightTable-td FightTable-td--alignCenter FantasyRankingsTable-td FantasyRankingsTable-td--rank">${rank}</td><td class="FightTable-td FantasyRankingsTable-td FantasyRankingsTable-td--player"><div class="FantasyRankingsTable-player"><img src="https://sports.cbsimg.net/images/football/nfl/players/170x170/1.png" class="FantasyRankingsTable-headshot"><div class="FantasyRankingsTable-playerText"><a class="FantasyRankingsTable-playerLink" href="/nfl/players/1/x/fantasy/"><span class="FantasyRankingsTable-playerName"><span class="FantasyRankingsTable-firstName">${first} </span><span class="FantasyRankingsTable-firstInitial">${init} </span>${last}</span></a><span class="FantasyRankingsTable-teamPosition">${team}</span></div></div></td><td class="FightTable-td FightTable-td--alignLeft FantasyRankingsTable-td FantasyRankingsTable-td--stats">${opp}</td><td class="FightTable-td FantasyRankingsTable-td FantasyRankingsTable-td--pos">${pos}</td><td class="FantasyRankingsTable-td FantasyRankingsTable-td--expert">1</td></tr>`;
const cbsHeader = `<tr class="FightTable-row FantasyRankingsTable-row FantasyRankingsTable-row--header"><th class="FantasyRankingsTable-th--rank">RK</th><th class="FantasyRankingsTable-th--player">Player</th><th class="FantasyRankingsTable-th--pos">POS</th></tr>`;
const cbsHtml = `<table>${cbsHeader}${cbsRow(1, 'Jahmyr', 'J.', 'Gibbs', 'DET', 'RB1')}${cbsRow(2, 'Puka', 'P.', 'Nacua', 'LAR', 'WR1')}${cbsRow(3, 'Bijan', 'B.', 'Robinson', 'ATL', 'RB2')}${cbsRow(4, 'Ka&#039;imi', 'K.', 'Fairbairn', 'HOU', '')}</table>
<tr class="FightTable-row FantasyRankingsTable-row"><td class="FantasyRankingsTable-td--rank">1</td><td class="FantasyRankingsTable-td--player"><div class="FantasyRankingsTable-player"><img src="https://sports.cbsimg.net/images/nfl/logos/250x250/HOU.png"><div class="FantasyRankingsTable-playerText"><span class="FantasyRankingsTable-playerName">Texans</span><span class="FantasyRankingsTable-icons"><span title="x"></span></span></div></div></td><td class="FantasyRankingsTable-td--pos"></td></tr>`;
const dsRow = (rank, first, last, team, pos, n) => `<tr class="player-row"><td class="ds-cell rank centered"><div class="column-title rank-index"><span>${rank}</span></div></td><td class="player-cell"><div class="player-details-group__team-position-container"><span class="player-details-group__team-name">${team}</span><pos-roster-spot pill="false" pos-roster-spot="${pos}">${n}</pos-roster-spot></div><player-name first-name="${first}" last-name="${last}" player-id="1" link modal></player-name></td></tr>`;
const dsHtml = `<table id="rankingsTable"><tr class="ds-table-divider-row"><td>Tier 1</td></tr>${dsRow(1, 'Jahmyr', 'Gibbs', 'DET', 'RB', 1)}${dsRow(2, 'Bijan', 'Robinson', 'ATL', 'RB', 2)}${dsRow(9, "Ja'Marr", 'Chase', 'CIN', 'WR', 4)}</table>`;
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
test('CBS parser reads the real FantasyRankingsTable layout, dropping the mobile initial and mapping defenses by logo', () => {
  const rows = R.parseCBS(cbsHtml.replace(/<tr class="FightTable-row FantasyRankingsTable-row"><td class="FantasyRankingsTable-td--rank">1<\/td>[\s\S]*$/, '</table>'), 'flex');
  assert.equal(rows.length, 3);                                   // the unknown-position row (empty POS on a flex page) is dropped
  assert.deepEqual(rows[0], { name: 'Jahmyr Gibbs', team: 'DET', pos: 'RB', rank: 1, posRank: 1 });
  assert.deepEqual([rows[1].pos, rows[1].posRank], ['WR', 1]);
  const k = R.parseCBS(cbsRow(1, 'Ka&#039;imi', 'K.', 'Fairbairn', 'HOU', ''), 'K');   // position pages: pos from kind
  assert.deepEqual([k[0].name, k[0].pos, k[0].posRank], ["Ka'imi Fairbairn", 'K', 1]);
  const dstRow = cbsHtml.slice(cbsHtml.indexOf('<tr class="FightTable-row FantasyRankingsTable-row"><td class="FantasyRankingsTable-td--rank">'));
  const dst = R.parseCBS(dstRow, 'DST')[0];
  assert.deepEqual([dst.name, dst.pos, dst.team], ['Texans', 'DEF', 'HOU']);
  assert.throws(() => R.parseCBS('<div></div>', 'QB'), /no ranking rows/);
});
test('Draft Sharks parser reads server-rendered player rows (name attrs, team, positional rank)', () => {
  const rows = R.parseDraftSharks(dsHtml, 'RB');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { name: 'Jahmyr Gibbs', team: 'DET', pos: 'RB', rank: 1, posRank: 1 });
  assert.deepEqual([rows[2].name, rows[2].pos, rows[2].posRank], ["Ja'Marr Chase", 'WR', 4]);
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
  assert.deepEqual(url(fp, sf), ['https://www.fantasypros.com/nfl/rankings/ppr-superflex.php']);
  assert.ok(url(ffc, sf)[0].includes('/adp/2qb?teams=10&year=2026'));
  assert.ok(url(ffc, half)[0].includes('/adp/half-ppr?teams=12'));
  // CBS only has PPR and standard pages (half-PPR uses PPR), always the weekly pages.
  assert.deepEqual(url(cbs, half), ['https://www.cbssports.com/fantasy/football/rankings/ppr/flex/weekly/', 'https://www.cbssports.com/fantasy/football/rankings/ppr/QB/weekly/', 'https://www.cbssports.com/fantasy/football/rankings/ppr/K/weekly/', 'https://www.cbssports.com/fantasy/football/rankings/ppr/DST/weekly/']);
  assert.ok(url(cbs, { ...half, scoring: 'std' }).every(u => u.includes('/standard/')));
  assert.equal(url(cbs, sf).length, 2);                                 // no K/DST in this league
  // Draft Sharks: one page per position, ppr or half-ppr (no standard page).
  assert.deepEqual(url(ds, half).map(u => u.split('/rankings/')[1]), ['half-ppr/qb', 'half-ppr/rb', 'half-ppr/wr', 'half-ppr/te', 'half-ppr/k', 'half-ppr/def']);
  assert.ok(url(ds, sf).every(u => u.includes('/ppr/')));
  assert.ok(url(ds, { ...half, scoring: 'std' }).every(u => u.includes('/half-ppr/')));
  const std = R.leagueProfile({ scoring_settings: { rec: 0 }, roster_positions: ['QB', 'QB', 'RB'] });
  assert.equal(std.scoring, 'std'); assert.equal(std.superflex, true);
});

test('loadSource merges pages, survives failures and reports per-URL status', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('/flex/weekly/')) return { ok: true, status: 200, text: async () => cbsHtml };
    if (url.includes('/QB/')) return { ok: false, status: 404, text: async () => '' };
    return { ok: false, status: 403, text: async () => 'blocked' };
  };
  const profile = { scoring: 'half', superflex: false, teams: 12, hasK: true, hasDef: true };
  const out = await R.loadSource(R.SOURCES[1], profile, { season: '2026' }, fakeFetch);
  assert.equal(out.rows.length, 3);
  assert.equal(out.error, null);
  assert.ok(out.tried.some(t => t.ok && t.url.endsWith('/ppr/flex/weekly/')));
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

// ---- hardened fallbacks (shapes I'd expect if the sites differ from my first guess)
const names = ['Josh Allen', 'Lamar Jackson', 'Jalen Hurts', 'Patrick Mahomes', 'Joe Burrow', 'Jayden Daniels', 'Baker Mayfield', 'Dak Prescott', 'Brock Purdy', 'Kyler Murray'];
const tableHtml = (inline) => `<table class="TableBase-table"><thead><tr><th>Rank</th><th>Player</th>${inline ? '' : '<th>Pos</th><th>Team</th>'}</tr></thead><tbody>${
  names.map((n, i) => `<tr><td>${i + 1}</td><td><span class="x">${n}</span> ${inline ? '<span>QB</span> <span>BUF</span>' : ''}</td>${inline ? '' : '<td>QB</td><td>BUF</td>'}</tr>`).join('')}</tbody></table>`;

test('generic table parser handles separate columns and inline "Name POS TEAM" cells', () => {
  for (const inline of [false, true]) {
    const rows = R.parseTables(tableHtml(inline), 'QB');
    assert.equal(rows.length, 10, `inline=${inline}`);
    assert.deepEqual([rows[0].name, rows[0].pos, rows[0].team, rows[9].posRank], ['Josh Allen', 'QB', 'BUF', 10]);
  }
  assert.throws(() => R.parseTables('<table><tr><td>x</td></tr></table>'), /no ranking table/);
});

test('unknown layouts fall back to the generic table parser', () => {
  assert.equal(R.parseCBS(tableHtml(true), 'QB').length, 10);   // unknown layout → generic table fallback
  assert.equal(R.parseDraftSharks(tableHtml(false), 'QB').length, 10);
});

test('embedded JSON is found in ld+json, plain JSON scripts and window assignments', () => {
  const arr = Array.from({ length: 12 }, (_, i) => ({ playerName: `P${i} Name`, positionAbbr: 'WR', teamAbbr: 'kc', overallRank: i + 1 }));
  const pad = ' '.repeat(250);
  const variants = [
    `<script type="application/json">${JSON.stringify({ a: { b: arr } })}${pad}</script>`,
    `<script>window.__DATA__ = ${JSON.stringify({ list: arr })};${pad}</script>`,
    `<script type="application/ld+json">${JSON.stringify({ items: arr })}${pad}</script>`,
  ];
  for (const v of variants) { const rows = R.parseEmbeddedJSON(`<html>${v}</html>`); assert.equal(rows.length, 12); assert.equal(rows[0].team, 'KC'); }
  assert.throws(() => R.parseEmbeddedJSON('<script>var x = 1;</script>'), /no embedded/);
});

test('debug mode reports status, structure and parse result without throwing', async () => {
  const fake = async (url) => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => `<title>CBS Rankings</title>${cbsHtml}Gibbs` });
  const d = await R.debugSource(R.SOURCES[1], { scoring: 'ppr', superflex: false, teams: 12, hasK: false, hasDef: false }, { season: '2026' }, fake);
  assert.equal(d.source, 'cbs');
  assert.equal(d.results.length, 2);   // flex + QB (this league has no K/DST)
  const r = d.results[0];
  assert.equal(r.status, 200); assert.equal(r.title, 'CBS Rankings'); assert.ok(r.parsed >= 3);
  assert.ok(r.sample.includes('Gibbs') && r.classes.some(([c]) => c === 'FantasyRankingsTable-playerName'));
  const bad = await R.debugSource(R.SOURCES[2], { scoring: 'ppr', superflex: false, teams: 12 }, {}, async () => { throw new Error('net down'); });
  assert.equal(bad.results[0].error, 'net down');
});
