import { sleeper } from './sleeper.js';
import { loadLeagueContext, finish } from './data.js';
import { demoContext } from './demo.js';
import * as E from './engine.js';
import { icon } from './icons.js';
import { fmtKickoff, isLocked, parseRankingsCSV } from './signals.js';
import { leagueProfile } from './rankingSources.js';

const $app = document.getElementById('app');
const TABS = [
  { id: 'overview', label: 'Overview', icon: 'gauge' },
  { id: 'lineup', label: 'Start / Sit', icon: 'lineup' },
  { id: 'waivers', label: 'Waivers', icon: 'plus' },
  { id: 'trades', label: 'Trades', icon: 'swap' },
  { id: 'roster', label: 'Roster', icon: 'people' },
];

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('fc:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('fc:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  screen: 'onboard', username: store.get('username') ?? '', user: null, leagues: [], error: null, step: '',
  ctx: null, me: null, tab: location.hash.slice(1) || 'overview',
  waiverPos: 'ALL', tradeMode: 'suggested', builder: { partner: null, give: new Set(), get: new Set() },
  memo: {}, expertWeight: store.get('xw') ?? 0.25, rankMsg: null,
  remote: { status: 'idle' }, srcOff: store.get('srcOff') ?? {},
};

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const f1 = (n) => (Math.round((n ?? 0) * 10) / 10).toFixed(1);
const signed = (n, d = 1) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n ?? 0).toFixed(d)}`;
const cls = (n) => (n > 0.05 ? 'pos' : n < -0.05 ? 'neg' : 'secondary');
const P = (id) => S.ctx.players[id];
const V = (id) => S.ctx.values[id];
const memo = (k, fn) => (k in S.memo ? S.memo[k] : (S.memo[k] = fn()));

function setState(patch) { Object.assign(S, patch); render(); }

// ---------- data flows ----------
async function lookupUser(name) {
  setState({ error: null, screen: 'loading', step: 'Finding your Sleeper account' });
  try {
    const user = await sleeper.user(name.trim());
    if (!user) throw new Error(`No Sleeper user named “${name}”.`);
    const state = await sleeper.state();
    let leagues = await sleeper.leagues(user.user_id, state.league_season ?? state.season);
    if (!leagues?.length && state.previous_season) leagues = await sleeper.leagues(user.user_id, state.previous_season);
    store.set('username', name.trim());
    const last = store.get('league');
    if (last && leagues.some(l => l.league_id === last)) return openLeague(last, { user, leagues });
    setState({ user, leagues: leagues ?? [], screen: 'leagues' });
  } catch (e) {
    setState({ screen: 'onboard', error: e.message || 'Could not reach Sleeper.' });
  }
}

async function openLeague(id, extra = {}) {
  setState({ ...extra, screen: 'loading', step: 'Loading league', error: null });
  try {
    const ctx = await loadLeagueContext(id, (step) => setState({ step }));
    const uid = S.user.user_id;
    const me = ctx.rosters.find(r => r.owner_id === uid || (r.co_owners ?? []).includes(uid));
    if (!me) throw new Error('You don’t own a team in this league.');
    store.set('league', id);
    startApp(ctx, me);
  } catch (e) {
    setState({ screen: S.leagues.length ? 'leagues' : 'onboard', error: e.message });
  }
}

function startDemo() {
  const ctx = demoContext();
  S.user = { user_id: 'u1', display_name: 'you' };
  S.leagues = [ctx.league];
  startApp(ctx, ctx.rosters.find(r => r.roster_id === ctx.myRosterId));
}

function startApp(ctx, me) {
  S.memo = {}; S.rankMsg = null; closeSheet(true);
  S.ctx = ctx; S.remote = { status: 'idle' }; applyExpert();
  S.builder = { partner: ctx.rosters.find(r => r.roster_id !== me.roster_id)?.roster_id ?? null, give: new Set(), get: new Set() };
  setState({ ctx, me, screen: 'app' });
  loadRemoteRankings();
}

function expertSets() {
  const sets = [];
  const rd = S.remote.data;
  if (rd) for (const src of rd.sources) {
    if (src.rows?.length) sets.push({ id: src.id, name: src.name, weight: src.weight, rows: src.rows, week: rd.week, enabled: !S.srcOff[src.id] });
  }
  const csv = store.get('rankings');
  if (csv?.rows?.length) sets.push({ id: 'csv', name: 'Imported file', weight: 1, rows: csv.rows, week: csv.week, enabled: !S.srcOff.csv });
  return sets;
}

function applyExpert() {
  const c = S.ctx;
  c.expertSets = expertSets(); c.expertWeight = S.expertWeight;
  finish(c);
  S.memo = {};
}

async function loadRemoteRankings(force = false) {
  const c = S.ctx;
  // The sample league has fictional players, so live rankings would match nothing (?forceRemote is for testing).
  if (c.demo && !location.search.includes('forceRemote')) { S.remote = { status: 'demo' }; return; }
  const key = `${c.league.league_id}:${c.week}`;
  const cached = store.get('remote');
  if (!force && cached?.key === key && Date.now() - cached.t < 30 * 60e3) {
    S.remote = { status: 'ok', data: cached.data, t: cached.t }; applyExpert(); return render();
  }
  S.remote = { status: 'loading' }; render();
  const prof = leagueProfile(c.league);
  try {
    const qs = new URLSearchParams({ scoring: prof.scoring, superflex: prof.superflex ? '1' : '0', teams: String(prof.teams), season: String(c.season),
      k: prof.hasK ? '1' : '0', dst: prof.hasDef ? '1' : '0', tep: prof.tePremium ? '1' : '0' });
    const res = await fetch(`/.netlify/functions/rankings?${qs}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'not-deployed' : `The rankings service returned HTTP ${res.status}`);
    const data = await res.json();
    data.week = c.week;
    if (S.ctx !== c) return; // switched leagues while loading
    store.set('remote', { key, t: Date.now(), data });
    S.remote = { status: 'ok', data, t: Date.now() };
  } catch (e) {
    if (S.ctx !== c) return;
    S.remote = e.message === 'not-deployed' ? { status: 'unavailable' } : { status: 'error', error: e.message || 'Could not reach the rankings service.' };
  }
  applyExpert(); render();
}

// ---------- computed ----------
const isLockedId = (id) => !!P(id)?.team && isLocked(P(id).team, S.ctx.slate);
const lineup = () => memo('lineup', () => E.startSit(S.me, S.ctx.league, S.ctx.players, S.ctx.values, E.lockedMap(S.me.players ?? [], S.ctx.players, S.ctx.slate)));
const analysis = () => memo('analysis', () => E.analyzeLeague(S.ctx.rosters, S.ctx.league, S.ctx.players, S.ctx.values));
const myTeam = () => analysis().teams.find(t => t.rosterId === S.me.roster_id);
const fas = () => memo('fas', () => E.freeAgentTargets(S.me, S.ctx.rosters, S.ctx.league, S.ctx.players, S.ctx.values));
const fab = () => {
  const L = S.ctx.league;
  if (!E.usesFab(L)) return null;
  const budget = L.settings.waiver_budget ?? 100;
  const spent = S.me.settings?.waiver_budget_used ?? 0;
  const lu = myTeam().lineup;
  const starters = lu.slots.filter(s => s.id).length || 1;
  return { budget, spent, week: S.ctx.week, numTeams: S.ctx.rosters.length, starterRos: lu.total / starters };
};
const trades = () => memo('trades', () => E.suggestTrades({ myRoster: S.me, rosters: S.ctx.rosters, league: S.ctx.league, players: S.ctx.players, values: S.ctx.values, week: S.ctx.week }));

// ---------- components ----------
const ago = (iso) => {
  const h = (Date.now() - Date.parse(iso)) / 36e5;
  return !(h >= 0) ? '' : h < 1 ? 'just now' : h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};
const gameLabel = (v) => v?.gameState === 'post' ? 'Final' : v?.gameState === 'in' ? 'In progress' : fmtKickoff(v?.kickoff);
const recentNews = (id) => (S.ctx.news?.[id] ?? []).filter(n => !n.published || Date.now() - Date.parse(n.published) < 2 * 864e5);

function playerRow(id, { trail = '', sub = '', notes = true, slot = null, interactive = false, extra = '', why = false } = {}) {
  const p = P(id); const v = V(id);
  if (!p) return `<li><span class="pbadge slot">${esc(slot ?? '—')}</span><div class="grow"><div class="name secondary">Empty</div></div></li>`;
  const meta = [slot && slot !== p.pos ? slot.replace('_', ' ') : null, p.team ?? 'FA', v?.opponent ? `vs ${v.opponent}` : null, gameLabel(v), sub].filter(Boolean).join(' · ');
  const chips = [...(notes ? (v?.notes ?? []).map(noteChip) : [])];
  if (isLockedId(id)) chips.unshift(`<span class="chip">${icon('lock', 12)}Locked · game ${v?.gameState === 'post' ? 'final' : 'started'}</span>`);
  if (notes && recentNews(id).length) chips.push(`<span class="chip blue">${icon('news', 12)}News</span>`);
  return `<li class="${interactive ? 'interactive' : ''}">
    <span class="pbadge ${esc(p.pos)}">${esc(p.pos)}</span>
    <div class="grow">
      <div class="name">${esc(p.name)}</div>
      <div class="meta">${esc(meta)}</div>
      ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}${extra}
    </div>
    <div class="trail">${trail}</div>
    ${why && v ? `<button class="why-toggle" data-why="${esc(id)}" aria-haspopup="dialog" aria-label="Why ${esc(p.name)} is projected ${f1(v.week)} points">${icon('chevron', 18)}</button>` : ''}
  </li>`;
}
function noteChip(n) {
  const map = { injury: ['red', 'cross'], bye: ['orange', 'calendar'], weather: [n.good ? 'green' : 'orange', 'wind'], matchup: [n.good ? 'green' : 'red', 'target'],
    usage: [n.good ? 'green' : 'orange', 'chart'], vegas: [n.good ? 'green' : 'orange', 'chart'] };
  const [c, ic] = map[n.kind] ?? ['', 'info'];
  return `<span class="chip ${c}">${icon(ic, 12)}${esc(n.text)}</span>`;
}

function breakdownPanel(id) {
  const v = V(id); const b = v.breakdown; const f = b.facts; const p = P(id);
  const none = (t) => `<li class="secondary">${t}</li>`;
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const rows = b.steps.map(st => `<tr><td>${esc(st.label)}<div class="caption secondary">${esc(st.detail)}</div></td>
      <td class="r num">×${st.mult.toFixed(2)}</td><td class="r num ${cls(st.delta)}">${signed(st.delta)}</td><td class="r num">${f1(st.after)}</td></tr>`).join('');
  const u = f.usage, env = f.env;
  const facts = [];
  facts.push(u
    ? `<li><b>Usage</b> · snaps ${pct(u.snap.l3)} last 3 (season ${pct(u.snap.season)})${u.tgt.l3 != null ? ` · target share ${pct(u.tgt.l3)} (${pct(u.tgt.season)}) · ${u.tgtPerGame} tgt/g` : ''}${p.pos === 'RB' && u.rush.l3 != null ? ` · rush share ${pct(u.rush.l3)} (${pct(u.rush.season)})` : ''}</li>`
    : none(['RB', 'WR', 'TE'].includes(p.pos) ? '<b>Usage</b> · not enough snap data yet (needs 4+ games)' : '<b>Usage</b> · not tracked for this position'));
  facts.push(env
    ? `<li><b>Game</b> · ${env.home ? 'vs' : '@'} ${esc(env.opp)} · ${esc(gameLabel(v) ?? 'time TBD')}${env.total ? ` · O/U ${env.total}` : ''}${env.margin != null ? ` · ${env.margin > 0 ? `favored by ${env.margin}` : env.margin < 0 ? `${-env.margin}-pt underdog` : 'pick’em'}` : ''}${env.implied != null ? ` · implied ${f1(env.implied)} pts` : ' · no betting line'}</li>`
    : none('<b>Game</b> · schedule/line data unavailable'));
  facts.push(isLockedId(id) ? `<li><b>Lineup lock</b> · this game has started, so he can’t be moved in Sleeper</li>` : env?.kickoff ? `<li><b>Lineup lock</b> · locks at kickoff, ${esc(fmtKickoff(env.kickoff))}</li>` : '');
  facts.push(f.expert
    ? `<li><b>Expert rank</b> · ${p.pos}${f.expert.posRank}${f.expert.ranks?.length > 1 ? ` (average of ${f.expert.ranks.map(r => `${esc(r.name)} ${p.pos}${r.posRank}`).join(', ')})` : f.expert.ranks?.length ? ` (${esc(f.expert.ranks[0].name)})` : ''} ≈ ${f1(f.expert.pts)} pts in this league · weighted ${Math.round(S.expertWeight * 100)}%</li>`
    : none('<b>Expert rank</b> · none for this player'));
  const news = (S.ctx.news?.[id] ?? []);
  facts.push(news.length
    ? `<li><b>News</b> (shown for context; it doesn’t change the number)<ul class="news">${news.map(n => `<li>${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.headline)}</a>` : esc(n.headline)} <span class="secondary">${esc(ago(n.published))}</span>${n.description ? `<div class="caption secondary">${esc(n.description)}</div>` : ''}</li>`).join('')}</ul></li>`
    : none('<b>News</b> · nothing recent'));
  return `<div class="why" role="region" aria-label="Projection breakdown for ${esc(p.name)}">
    <div class="scroll-x"><table class="tbl compact"><thead><tr><th>Factor</th><th class="r">Effect</th><th class="r">Pts</th><th class="r">Running</th></tr></thead><tbody>
      <tr><td>${esc(b.baseLabel)}</td><td></td><td></td><td class="r num">${f1(b.base)}</td></tr>${rows}
      <tr class="me"><td>Projected this week</td><td></td><td class="r num ${cls(b.final - b.base)}">${signed(b.final - b.base)}</td><td class="r num">${f1(b.final)}</td></tr>
    </tbody></table></div>
    <ul class="facts">${facts.join('')}</ul>
  </div>`;
}
const kpi = (label, ic, value, unit = '', delta = '') =>
  `<div class="card kpi"><div class="label">${icon(ic, 16)}${esc(label)}</div><div class="value">${value}${unit ? `<small>${unit}</small>` : ''}</div>${delta ? `<div class="delta">${delta}</div>` : ''}</div>`;
const gradeColor = (g) => g.startsWith('A') ? 'var(--green)' : g.startsWith('B') ? 'var(--teal)' : g === 'C' ? 'var(--orange)' : 'var(--red)';
const gradeRing = (g, pct, sm = false) => `<div class="grade ${sm ? 'sm' : ''}" style="--c:${gradeColor(g)};--p:${pct}" role="img" aria-label="Grade ${g}"><b>${esc(g)}</b></div>`;
const gradePct = { 'A+': 100, A: 92, 'A-': 85, 'B+': 75, B: 65, C: 50, D: 30, F: 12 };

// ---------- screens ----------
function renderOnboard() {
  return `<div class="onboard"><div class="card stack">
    <div class="brand-mark hero-icon">${icon('football', 40)}</div>
    <h1 class="large-title">Fantasy Caddie</h1>
    <p class="secondary" style="margin:0">Connect your Sleeper account to get start/sit calls, waiver targets with FAB bids, and graded trade ideas for every league you’re in.</p>
    <form class="stack" data-form="user" style="margin-top:8px">
      <label class="footnote secondary" for="u">SLEEPER USERNAME</label>
      <input id="u" class="field" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="e.g. caddiefan" value="${esc(S.username)}" required>
      ${S.error ? `<div class="footnote error" role="alert">${esc(S.error)}</div>` : ''}
      <button class="btn primary block" type="submit">Continue ${icon('chevron', 16)}</button>
    </form>
    <button class="btn plain block" data-action="demo">${icon('sparkles', 18)}Explore with a sample league</button>
    <p class="caption secondary" style="margin:0">Read-only: Sleeper’s public API needs no password. Fantasy Caddie never changes your lineup or sends trades.</p>
  </div></div>`;
}

function renderLoading() {
  return `<div class="onboard"><div class="card"><div class="progress"><div class="spinner" aria-hidden="true"></div><span role="status">${esc(S.step)}…</span></div></div></div>`;
}

function renderLeagues() {
  return `<div class="onboard"><div class="card stack" style="padding-inline:0">
    <div style="padding:0 var(--s4)"><h1 class="large-title">Your Leagues</h1>
    <p class="secondary" style="margin:8px 0 0">Signed in as ${esc(S.user?.display_name)}. <button class="btn plain" data-action="signout">Switch</button></p>
    ${S.error ? `<p class="footnote error" role="alert">${esc(S.error)}</p>` : ''}</div>
    ${S.leagues.length ? `<ul class="list">${S.leagues.map(l => `
      <li class="interactive" data-action="league" data-id="${esc(l.league_id)}" tabindex="0" role="button">
        <span class="pbadge slot">${icon('trophy', 22)}</span>
        <div class="grow"><div class="name">${esc(l.name)}</div>
        <div class="meta">${l.total_rosters} teams · ${l.season} · ${E.usesFab(l) ? 'FAB waivers' : 'Rolling waivers'}</div></div>
        <span class="secondary">${icon('chevron', 16)}</span></li>`).join('')}</ul>`
      : `<div class="empty">${icon('trophy', 40)}<div>No NFL leagues found for this season.</div></div>`}
  </div></div>`;
}

function renderApp() {
  const tab = TABS.find(t => t.id === S.tab) ?? TABS[0];
  const L = S.ctx.league;
  const nav = TABS.map(t => `<button class="nav-item" data-tab="${t.id}" ${t.id === tab.id ? 'aria-current="page"' : ''}>${icon(t.icon, 22)}<span>${t.label}</span></button>`).join('');
  const views = { overview: viewOverview, lineup: viewLineup, waivers: viewWaivers, trades: viewTrades, roster: viewRoster };
  return `<div class="shell">
    <nav class="sidebar" aria-label="Sections">
      <div class="brand"><div class="brand-mark">${icon('football', 20)}</div><div><div class="headline">Fantasy Caddie</div><div class="caption secondary">${esc(S.ctx.teamName(S.me.roster_id))}</div></div></div>
      ${nav}
      <div class="spacer"></div>
      ${S.leagues.length > 1 ? `<label class="caption secondary" for="lg" style="padding:0 12px">LEAGUE</label><select id="lg" class="field" data-change="league">${S.leagues.map(l => `<option value="${esc(l.league_id)}" ${l.league_id === L.league_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : ''}
      ${S.ctx.demo ? '' : `<button class="nav-item" data-action="refresh">${icon('refresh', 22)}<span>Refresh data</span></button>`}
      <button class="nav-item" data-action="signout">${icon('logout', 22)}<span>${S.ctx.demo ? 'Exit demo' : 'Sign out'}</span></button>
    </nav>
    <main id="main">
      <div class="page-head">
        <div><div class="eyebrow">Week ${S.ctx.week} · ${esc(L.name)}</div><h1 class="large-title">${tab.label}</h1></div>
        ${S.ctx.demo ? '<span class="chip blue">Sample data</span>' : ''}
      </div>
      ${views[tab.id]()}
    </main>
    <nav class="tabbar" aria-label="Sections">${TABS.map(t => `<button data-tab="${t.id}" ${t.id === tab.id ? 'aria-current="page"' : ''}>${icon(t.icon, 24)}<span>${t.label}</span></button>`).join('')}</nav>
  </div>`;
}

// ---------- views ----------
function viewOverview() {
  const a = analysis(); const me = myTeam(); const lu = lineup();
  const n = a.teams.length; const f = fab(); const top = fas()[0];
  const record = S.me.settings ? `${S.me.settings.wins ?? 0}–${S.me.settings.losses ?? 0}${S.me.settings.ties ? '–' + S.me.settings.ties : ''}` : '';
  const actions = [];
  if (lu.gain > 0.2) actions.push({ tab: 'lineup', ic: 'lineup', c: 'blue', title: `Fix your lineup: ${signed(lu.gain)} pts`, sub: lu.moves.slice(0, 2).map(m => m.start ? `Start ${P(m.start)?.name}` : `Bench ${P(m.sit)?.name}`).join(' · ') });
  if (top) {
    const bid = f ? E.fabBid(top, f) : null;
    actions.push({ tab: 'waivers', ic: 'plus', c: 'green', title: `Add ${P(top.id).name} (${P(top.id).pos})`, sub: `${top.gainRos > 0.5 ? `${signed(top.gainRos)} ROS pts` : `${signed(top.gainWeek)} pts this week`}${bid ? ` · bid $${bid.rec}` : ''}${top.drop ? ` · drop ${P(top.drop).name}` : ''}` });
  }
  const t = S.memo.trades?.[0];
  actions.push(t
    ? { tab: 'trades', ic: 'swap', c: 'indigo', title: `Trade idea graded ${t.grade}`, sub: `Get ${t.get.map(id => P(id).name).join(' + ')} from ${S.ctx.teamName(t.rosterId)}` }
    : { tab: 'trades', ic: 'swap', c: 'indigo', title: 'Find trade targets', sub: 'Scan every roster for deals that raise your ROS points' });
  const maxAbs = Math.max(1, ...a.positions.map(p => Math.abs(me.posVsMedian?.[p] ?? 0)));

  return `<div class="stack">
    <div class="grid kpis">
      ${kpi('Power rank', 'trophy', `#${me.rank}`, `of ${n}`, record ? `Record ${record}` : 'By rest-of-season lineup strength')}
      ${kpi('Week ' + S.ctx.week + ' projection', 'chart', f1(lu.best.total), 'pts', lu.gain > 0.2 ? `<span class="pos">${signed(lu.gain)}</span> vs your current lineup` : 'Your lineup is optimal')}
      ${kpi('Rest of season', 'calendar', Math.round(me.ros), 'pts', `${E.remainingWeeks(S.ctx.week)} weeks left · starters only`)}
      ${f ? kpi('FAB remaining', 'dollar', `$${f.budget - f.spent}`, `/ $${f.budget}`, `${Math.round(((f.budget - f.spent) / f.budget) * 100)}% of budget left`)
          : kpi('Waiver priority', 'list', `#${S.me.settings?.waiver_position ?? '—'}`, '', 'Rolling waivers')}
    </div>
    <div class="grid split">
      <section class="card flush"><header><h2 class="title3">Best moves this week</h2></header>
        <ul class="list">${actions.map(x => `<li class="interactive" data-tab="${x.tab}" role="button" tabindex="0">
          <span class="pbadge" style="background:var(--${x.c})">${icon(x.ic, 22)}</span>
          <div class="grow"><div class="name">${esc(x.title)}</div><div class="meta">${esc(x.sub)}</div></div>
          <span class="secondary">${icon('chevron', 16)}</span></li>`).join('')}</ul>
      </section>
      <section class="card"><header><h2 class="title3">Strength vs league</h2><span class="caption secondary">ROS pts vs median</span></header>
        <div class="stack" style="gap:12px">${a.positions.map(p => {
          const d = me.posVsMedian?.[p] ?? 0; const w = Math.abs(d) / maxAbs * 50;
          return `<div><div class="row between subhead"><span><b>${p}</b> <span class="secondary">#${me.posRank[p]}</span></span><span class="num ${cls(d)}">${signed(d, 0)}</span></div>
            <div class="diverge" aria-hidden="true"><span style="${d >= 0 ? `left:50%;width:${w}%;background:var(--green)` : `right:50%;width:${w}%;background:var(--red)`}"></span></div></div>`;
        }).join('')}</div>
      </section>
    </div>
    <section class="card flush"><header><h2 class="title3">Power rankings</h2><span class="caption secondary">Projected ROS starter points</span></header>
      <div class="scroll-x">${powerTable(a, 6)}</div>
    </section>
  </div>`;
}

function powerTable(a, limit = Infinity) {
  const rows = [...a.teams].sort((x, y) => x.rank - y.rank).slice(0, limit);
  if (!rows.some(t => t.rosterId === S.me.roster_id)) rows.push(myTeam());
  const max = Math.max(...a.teams.map(t => t.ros));
  return `<table class="tbl"><thead><tr><th>#</th><th>Team</th><th class="r">Record</th><th>ROS strength</th><th class="r">This week</th>${a.positions.map(p => `<th class="r">${p}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(t => { const r = S.ctx.rosters.find(x => x.roster_id === t.rosterId);
      return `<tr class="${t.rosterId === S.me.roster_id ? 'me' : ''}"><td class="num">${t.rank}</td><td>${esc(S.ctx.teamName(t.rosterId))}</td>
      <td class="r num">${r.settings?.wins ?? 0}–${r.settings?.losses ?? 0}</td>
      <td style="min-width:140px"><div class="row"><div class="bar" style="flex:1"><span style="width:${(t.ros / max * 100).toFixed(1)}%"></span></div><span class="num footnote">${Math.round(t.ros)}</span></div></td>
      <td class="r num">${f1(t.weekly)}</td>${a.positions.map(p => `<td class="r num ${t.posRank[p] <= 3 ? 'pos' : t.posRank[p] > a.teams.length - 3 ? 'neg' : ''}">${t.posRank[p]}</td>`).join('')}</tr>`; }).join('')}
  </tbody></table>`;
}

function sourcesCard() {
  const so = S.ctx.sources;
  const chip = (ok, label, detail) => `<span class="chip ${ok ? 'green' : ''}">${icon(ok ? 'check' : 'info', 12)}${esc(label)}${detail ? ` · ${esc(detail)}` : ''}</span>`;
  const n = (o) => Object.keys(o ?? {}).length;
  return `<section class="card"><header><h2 class="title3">Data behind these numbers</h2></header>
    <div class="chips" style="margin:0">
      ${chip(so.projections, 'Sleeper projections')}
      ${chip(so.lines, 'Vegas lines', so.lines ? `${n(S.ctx.slate) / 2} games` : 'unavailable')}
      ${chip(so.kickoffs, 'Kickoff times')}
      ${chip(so.usage, 'Snap & target share', so.usage ? `${n(S.ctx.usage)} players` : 'not enough games yet')}
      ${chip(so.weather, 'Weather')}
      ${chip(so.news, 'News', so.news ? `${n(S.ctx.news)} players` : 'unavailable')}
      ${chip(so.experts > 0, 'Expert rankings', so.experts ? `${so.experts} players` : 'none loaded')}
    </div>
    <p class="footnote secondary" style="margin:12px 0 0">Open any player’s <b>chevron</b> to see his base projection and each adjustment in order. Grey items weren’t available, so they are left out of the math instead of guessed.</p>
  </section>`;
}

function expertCard() {
  const csv = store.get('rankings');
  const prof = leagueProfile(S.ctx.league);
  const stats = S.ctx.expertStats;
  const per = (id) => stats?.perSource.find(x => x.id === id);
  const weights = [[0, 'Off'], [0.15, 'Light'], [0.25, 'Medium'], [0.4, 'Heavy']];
  const R = S.remote;
  const sw = (id, on) => `<label class="check" style="width:auto"><input type="checkbox" data-src="${id}" ${on ? 'checked' : ''} aria-label="Use ${id}"></label>`;
  const srcRow = (src) => {
    const ok = src.rows?.length;
    const m = per(src.id);
    const used = src.tried?.find(t => t.ok);
    const lastErr = src.tried?.filter(t => !t.ok).map(t => t.error).at(-1) ?? src.error;
    return `<li>${sw(src.id, !S.srcOff[src.id])}<div class="grow">
        <div class="name"><a href="${esc(src.home)}" target="_blank" rel="noopener" style="color:inherit">${esc(src.name)}</a>${src.weight < 1 ? ` <span class="caption secondary">weight ${src.weight}</span>` : ''}</div>
        <div class="meta" style="white-space:normal">${ok ? `${src.rows.length} players${m ? ` · ${m.matched} matched on Sleeper` : ''}${used ? ` · ${esc(used.url.replace(/^https?:\/\/(www\.)?/, ''))}` : ''}` : esc(lastErr ?? 'No data')}</div>
      </div><span class="chip ${ok ? 'green' : 'red'}">${ok ? 'Loaded' : 'Failed'}</span></li>`;
  };
  let remote;
  if (R.status === 'loading') remote = `<li><div class="progress"><div class="spinner"></div><span role="status">Fetching expert rankings for your league…</span></div></li>`;
  else if (R.status === 'ok') remote = R.data.sources.map(srcRow).join('');
  else if (R.status === 'demo') remote = `<li class="secondary">Live rankings are skipped in the sample league.</li>`;
  else if (R.status === 'unavailable') remote = `<li class="secondary">The rankings service only runs on the Netlify deploy (it isn’t available here). You can still import a CSV below.</li>`;
  else if (R.status === 'error') remote = `<li class="error">${esc(R.error)}</li>`;
  else remote = '';
  const csvRow = csv?.rows?.length ? `<li>${sw('csv', !S.srcOff.csv)}<div class="grow"><div class="name">Imported file</div><div class="meta">${csv.rows.length} rows · week ${csv.week}${per('csv') ? ` · ${per('csv').matched} matched` : ''}${csv.week !== S.ctx.week ? ' · out of date, ignored' : ''}</div></div><button class="btn plain" data-action="clear-rankings">Remove</button></li>` : '';
  return `<section class="card flush"><header><h2 class="title3">Expert rankings</h2>
      <span class="chip ${stats ? 'green' : ''}">${stats ? `${stats.matched} players ranked` : 'Not loaded'}</span></header>
    <div style="padding:0 var(--s3) var(--s2)">
      <p class="subhead secondary" style="margin:0">Pages are chosen to match your league: <b style="color:var(--label)">${esc(prof.label)}</b>. Each source’s positional rank is turned into points for your scoring, averaged across sources, then blended into the projection last.</p>
      ${prof.tePremium ? '<p class="footnote" style="margin:8px 0 0;color:var(--orange)">Your league has TE premium scoring, which these rankings don’t account for. Treat TE ranks with caution.</p>' : ''}
    </div>
    <ul class="list plain">${remote}${csvRow}</ul>
    <div class="row wrap" style="padding:var(--s2) var(--s3) var(--s3)">
      <label class="btn"><span class="row" style="gap:8px">${icon('upload', 18)}Import CSV</span><input type="file" accept=".csv,text/csv" data-rankings hidden></label>
      ${R.status === 'ok' || R.status === 'error' ? `<button class="btn" data-action="refresh-ranks">${icon('refresh', 18)}Refresh</button>` : ''}
      <span class="grow"></span>
      <div class="segmented" role="group" aria-label="Expert weight">${weights.map(([w, l]) => `<button data-xw="${w}" aria-pressed="${S.expertWeight === w}">${l}</button>`).join('')}</div>
    </div>
    ${S.rankMsg ? `<p class="footnote ${S.rankMsg.err ? 'error' : 'secondary'}" style="margin:0 var(--s3) var(--s3)" role="status">${esc(S.rankMsg.text)}</p>` : ''}
  </section>`;
}

function viewLineup() {
  const lu = lineup(); const bench = lu.best.bench;
  const weatherIds = [...lu.best.starters].filter(id => V(id)?.notes.some(n => n.kind === 'weather'));
  const lockedStarters = lu.best.slots.filter(s => s.locked);
  const moveHtml = (m) => {
    const why = E.explainMove(m.start, m.sit, S.ctx.values, S.ctx.players);
    return `<div class="stack" style="gap:8px"><div class="swap">
        <div class="side"><div class="caption secondary">START</div><ul class="list plain" style="margin:0 calc(-1 * var(--s3))">${m.start ? playerRow(m.start, { trail: `<div class="big num">${f1(V(m.start)?.week)}</div>` }) : '<li class="secondary">—</li>'}</ul></div>
        <div class="arrow">${icon('swap', 24)}</div>
        <div class="side"><div class="caption secondary">SIT</div><ul class="list plain" style="margin:0 calc(-1 * var(--s3))">${m.sit ? playerRow(m.sit, { trail: `<div class="big num">${f1(V(m.sit)?.week)}</div>` }) : '<li class="secondary">Open slot</li>'}</ul></div>
      </div>
      <div class="callout" style="padding:12px">${icon('info', 20)}<div class="footnote"><b>Why (${signed(m.gain)} pts):</b><br>${why.map(esc).join('<br>')}</div></div></div>`;
  };
  return `<div class="stack">
    <div class="callout">${icon('sparkles', 22)}<div>
      <div class="headline">Optimal lineup projects ${f1(lu.best.total)} pts</div>
      <div class="subhead secondary">${lu.gain > 0.2 ? `That’s <b class="pos">${signed(lu.gain)}</b> over the lineup currently set in Sleeper.` : 'Your saved lineup already matches the optimal one.'}${lockedStarters.length ? ` ${lockedStarters.length} starter${lockedStarters.length > 1 ? 's' : ''} already played and ${lockedStarters.length > 1 ? 'are' : 'is'} locked in.` : ''}</div>
    </div></div>
    ${lu.moves.length ? `<section class="card flush"><header><h2 class="title3">Recommended moves</h2></header><div class="stack" style="padding:var(--s2) var(--s3) var(--s3)">
      ${lu.moves.map(moveHtml).join('<hr style="border:0;border-top:.5px solid var(--separator);margin:0;width:100%">')}
    </div></section>` : ''}
    <div class="grid two">
      <section class="card flush"><header><h2 class="title3">Starters</h2><span class="caption secondary">Projected pts</span></header>
        <ul class="list">${lu.best.slots.map(s => playerRow(s.id, { slot: s.slot, why: true, trail: `<div class="big num">${f1(s.value)}</div><div class="caption secondary">${V(s.id)?.rawWeek != null && Math.abs(V(s.id).rawWeek - s.value) >= 0.1 ? `base ${f1(V(s.id).rawWeek)}` : ''}</div>` })).join('')}</ul>
      </section>
      <section class="card flush"><header><h2 class="title3">Bench</h2><span class="caption secondary">Projected pts</span></header>
        ${bench.length ? `<ul class="list">${bench.map(id => playerRow(id, { why: true, trail: `<div class="big num secondary">${f1(V(id)?.week)}</div>` })).join('')}</ul>` : '<div class="empty">No bench players.</div>'}
      </section>
    </div>
    ${sourcesCard()}
    ${expertCard()}
    ${weatherIds.length ? `<section class="card"><header><h2 class="title3">${icon('wind', 20)} Weather watch</h2></header>
      <div class="subhead secondary">${weatherIds.map(id => `<b style="color:var(--label)">${esc(P(id).name)}</b> — ${esc(S.ctx.weather[P(id).team]?.summary)}`).join('<br>')}</div></section>` : ''}
  </div>`;
}

function viewWaivers() {
  const all = fas(); const f = fab();
  const list = all.filter(x => S.waiverPos === 'ALL' || P(x.id).pos === S.waiverPos);
  const positions = ['ALL', ...new Set(all.map(x => P(x.id).pos))];
  const remaining = f ? f.budget - f.spent : 0;
  return `<div class="stack">
    <div class="grid kpis">
      ${f ? kpi('FAB remaining', 'dollar', `$${remaining}`, `/ $${f.budget}`, `${E.remainingWeeks(S.ctx.week)} weeks left to spend it`) : kpi('Waiver type', 'list', 'Rolling', '', `Your priority: #${S.me.settings?.waiver_position ?? '—'}`)}
      ${kpi('Upgrades found', 'plus', list.length, '', 'Players who improve your lineup')}
      ${kpi('Best ROS gain', 'chart', signed(all[0]?.gainRos ?? 0), 'pts', all[0] ? esc(P(all[0].id).name) : '')}
      ${kpi('Best for this week', 'calendar', signed(Math.max(0, ...all.map(x => x.gainWeek))), 'pts', 'Streaming pickup')}
    </div>
    <div class="segmented" role="group" aria-label="Filter by position">${positions.map(p => `<button data-waiverpos="${p}" aria-pressed="${S.waiverPos === p}">${p === 'ALL' ? 'All' : p}</button>`).join('')}</div>
    <section class="card flush">
      <header><h2 class="title3">Waiver targets</h2>${f ? '<span class="caption secondary">Suggested blind bid</span>' : ''}</header>
      ${list.length ? `<ul class="list">${list.map(x => {
        const bid = f ? E.fabBid(x, f) : null;
        const trail = bid
          ? `<div class="big num">$${bid.rec}</div><div class="caption secondary num">$${bid.low}–$${bid.high} · ${bid.pctOfRemaining}%</div>`
          : `<div class="big num ${cls(x.gainRos)}">${signed(x.gainRos)}</div><div class="caption secondary">${x.gainRos >= 15 ? 'Worth your priority' : 'Add after waivers clear'}</div>`;
        const sub = `${signed(x.gainRos)} ROS · ${signed(x.gainWeek)} this wk${x.drop ? ` · drop ${P(x.drop).name}` : ''}`;
        const kind = `<span class="chip ${x.kind === 'hold' ? 'green' : 'blue'}">${x.kind === 'hold' ? 'Season-long add' : 'Streamer'}</span>${x.demand ? `<span class="chip orange">${x.demand} other team${x.demand > 1 ? 's' : ''} need him</span>` : ''}`;
        return playerRow(x.id, { sub, trail, extra: `<div class="chips">${kind}</div>` });
      }).join('')}</ul>` : `<div class="empty">${icon('check', 40)}<div>No free agent beats your current lineup at this position.</div></div>`}
    </section>
    ${f ? `<p class="footnote secondary" style="margin:0 8px">Bids scale with how much of a typical starter’s rest-of-season output the player adds, how many weeks remain, and how many other rosters would also start him. Bid the low end when nobody else needs him; go to the high end for a must-have or late in the season when unspent FAB is worthless.</p>` : ''}
  </div>`;
}

function viewTrades() {
  return `<div class="stack">
    <div class="segmented" role="group" aria-label="Trade mode">
      <button data-trademode="suggested" aria-pressed="${S.tradeMode === 'suggested'}">Suggested</button>
      <button data-trademode="build" aria-pressed="${S.tradeMode === 'build'}">Trade builder</button>
    </div>
    ${S.tradeMode === 'suggested' ? suggestedTrades() : tradeBuilder()}
  </div>`;
}

function suggestedTrades() {
  if (!('trades' in S.memo)) {
    setTimeout(() => { trades(); render(); }, 30);
    return `<div class="card"><div class="progress"><div class="spinner"></div><span role="status">Evaluating thousands of trade combinations across ${S.ctx.rosters.length - 1} rosters…</span></div></div>`;
  }
  const list = trades();
  if (!list.length) return `<div class="card empty">${icon('swap', 40)}<div>No trades found that improve your team and look acceptable to the other side. Try the trade builder.</div></div>`;
  return `<div class="grid two">${list.map((t, i) => tradeCard(t, i)).join('')}</div>
    <p class="footnote secondary" style="margin:0 8px">Ranked by points gained × likelihood of acceptance. Acceptance weighs the trade value the other manager receives (points over replacement) and how their own lineup changes.</p>`;
}

function tradeCard(t, i) {
  const side = (ids) => `<ul class="list plain" style="margin:0 calc(-1 * var(--s3))">${ids.map(id => playerRow(id, { notes: false, trail: `<div class="num footnote secondary">${f1(V(id)?.rate)}/g</div>` })).join('')}</ul>`;
  return `<section class="card flush">
    <header><div><div class="caption secondary">WITH</div><h2 class="headline" style="margin:0">${esc(S.ctx.teamName(t.rosterId))}</h2></div>${gradeRing(t.grade, gradePct[t.grade], true)}</header>
    <div style="padding:var(--s1) var(--s3) 0"><div class="caption secondary">YOU GIVE</div>${side(t.give)}<div class="caption secondary" style="margin-top:8px">YOU GET</div>${side(t.get)}</div>
    <div class="row wrap" style="padding:var(--s2) var(--s3) var(--s3);gap:var(--s2)">
      <div><div class="caption secondary">ROS gain</div><div class="headline num pos">${signed(t.myDelta)} pts</div></div>
      <div><div class="caption secondary">Per week</div><div class="headline num ${cls(t.perWeek)}">${signed(t.perWeek)}</div></div>
      <div><div class="caption secondary">Their change</div><div class="headline num ${cls(t.theirDelta)}">${signed(t.theirDelta)}</div></div>
      <div><div class="caption secondary">Accept odds</div><div class="headline num">~${t.accept}%</div></div>
      <button class="btn" style="margin-left:auto" data-action="open-trade" data-i="${i}">${icon('slider', 18)}Edit</button>
    </div>
  </section>`;
}

function tradeBuilder() {
  const B = S.builder;
  const them = S.ctx.rosters.find(r => r.roster_id === B.partner);
  const sortIds = (r) => (r?.players ?? []).filter(id => P(id)).sort((a, b) => (V(b)?.ros ?? 0) - (V(a)?.ros ?? 0));
  const pick = (r, set, kind) => `<ul class="list plain">${sortIds(r).map(id => {
    const p = P(id);
    return `<li><label class="check"><input type="checkbox" data-pick="${kind}" value="${esc(id)}" ${set.has(id) ? 'checked' : ''}>
      <span class="pbadge ${p.pos}">${p.pos}</span><span class="grow" style="min-width:0"><span class="name" style="display:block">${esc(p.name)}</span><span class="meta" style="display:block">${p.team ?? 'FA'}${p.injury ? ' · ' + esc(p.injury) : ''}</span></span>
      <span class="trail"><span class="num footnote" style="display:block">${f1(V(id)?.ros)}</span><span class="caption secondary">ROS</span></span></label></li>`;
  }).join('')}</ul>`;
  let result = `<div class="empty">${icon('slider', 40)}<div>Select players on both sides to grade the trade.</div></div>`;
  if (them && (B.give.size || B.get.size)) {
    const e = E.evaluateTrade({ myRoster: S.me, theirRoster: them, give: [...B.give], get: [...B.get], league: S.ctx.league, players: S.ctx.players, values: S.ctx.values, week: S.ctx.week });
    const verdict = e.myDelta > 0 && e.theirDelta > 0 ? 'Win–win: both lineups improve. Lead with this one.'
      : e.myDelta > 0 && e.accept >= 50 ? 'Good for you and likely acceptable on value.'
      : e.myDelta > 0 ? 'Helps you, but they give up more value than they get. Consider adding a sweetener.'
      : 'This lowers your projected rest-of-season points.';
    result = `<div class="row" style="gap:var(--s3);align-items:center;flex-wrap:wrap">${gradeRing(e.grade, gradePct[e.grade])}
      <div class="grow" style="min-width:200px"><div class="title2 num ${cls(e.myDelta)}">${signed(e.myDelta)} ROS pts</div><div class="subhead secondary">${esc(verdict)}</div></div></div>
      <div class="grid kpis" style="margin-top:var(--s3)">
        <div><div class="caption secondary">Per week</div><div class="title3 num ${cls(e.perWeek)}">${signed(e.perWeek)}</div></div>
        <div><div class="caption secondary">This week</div><div class="title3 num ${cls(e.myWeek)}">${signed(e.myWeek)}</div></div>
        <div><div class="caption secondary">Their ROS change</div><div class="title3 num ${cls(e.theirDelta)}">${signed(e.theirDelta)}</div></div>
        <div><div class="caption secondary">Accept odds</div><div class="title3 num">~${e.accept}%</div></div>
      </div>
      <div class="footnote secondary" style="margin-top:var(--s2)">Trade value: you send <b class="num">${f1(e.giveVal)}</b>, you receive <b class="num">${f1(e.getVal)}</b> (points over replacement). Uneven player counts assume the team receiving extra players drops its lowest-value player.</div>`;
  }
  return `<section class="card">${result}</section>
    <div class="row wrap"><label class="subhead secondary" for="partner">Trade partner</label>
      <select id="partner" class="field" style="max-width:360px" data-change="partner">${S.ctx.rosters.filter(r => r.roster_id !== S.me.roster_id).map(r => `<option value="${r.roster_id}" ${r.roster_id === B.partner ? 'selected' : ''}>${esc(S.ctx.teamName(r.roster_id))}</option>`).join('')}</select>
      <button class="btn plain" data-action="clear-trade">Clear</button></div>
    <div class="grid two">
      <section class="card flush"><header><h2 class="title3">You give</h2><span class="caption secondary">${B.give.size} selected</span></header>${pick(S.me, B.give, 'give')}</section>
      <section class="card flush"><header><h2 class="title3">You get</h2><span class="caption secondary">${B.get.size} selected</span></header>${pick(them, B.get, 'get')}</section>
    </div>`;
}

function viewRoster() {
  const ids = (S.me.players ?? []).filter(id => P(id)).sort((a, b) => (V(b)?.ros ?? 0) - (V(a)?.ros ?? 0));
  const starters = myTeam().lineup.starters;
  return `<div class="stack">
    <section class="card flush"><header><h2 class="title3">My roster</h2><span class="caption secondary">Sorted by rest-of-season value</span></header>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>Player</th><th>Status</th><th class="r">Wk ${S.ctx.week}</th><th class="r">Pts/G</th><th class="r">ROS</th><th class="r">Value</th></tr></thead><tbody>
      ${ids.map(id => { const p = P(id); const v = V(id) ?? {};
        return `<tr><td><div class="row"><span class="pbadge ${p.pos}" style="width:32px;height:32px;border-radius:8px;font-size:11px">${p.pos}</span><div><div>${esc(p.name)}</div><div class="caption secondary">${p.team ?? 'FA'}${p.age ? ` · ${p.age}y` : ''}</div></div></div></td>
        <td>${p.injury ? `<span class="chip red">${esc(p.injury)}</span>` : starters.has(id) ? '<span class="chip green">Core starter</span>' : '<span class="chip">Depth</span>'}</td>
        <td class="r num">${f1(v.week)}</td><td class="r num">${f1(v.rate)}</td><td class="r num">${f1(v.ros)}</td><td class="r num">${f1(v.vor)}</td></tr>`; }).join('')}
      </tbody></table></div>
    </section>
    <section class="card flush"><header><h2 class="title3">League power rankings</h2><span class="caption secondary">Position columns show league rank</span></header><div class="scroll-x">${powerTable(analysis())}</div></section>
    <p class="footnote secondary" style="margin:0 8px">“Value” is projected points above a replacement-level player at the same position, which is what other managers effectively pay for in a trade.</p>
  </div>`;
}

// ---------- Bottom sheet (projection breakdown) ----------
let sheet = null;
const sheetRoot = () => document.getElementById('sheet-root');

function sheetHtml(id) {
  const p = P(id), v = V(id);
  const delta = v.breakdown.final - v.breakdown.base;
  return `<div class="sheet-backdrop" data-sheet-close></div>
  <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">
    <header class="sheet-head">
      <div class="sheet-grab" aria-hidden="true"><span></span></div>
      <div class="row" style="gap:12px;align-items:center">
        <span class="pbadge ${esc(p.pos)}">${esc(p.pos)}</span>
        <div class="grow" style="min-width:0"><h2 id="sheet-title" class="title3" style="margin:0">${esc(p.name)}</h2>
          <div class="meta secondary subhead">${esc([p.team ?? 'FA', v.opponent ? `vs ${v.opponent}` : null, gameLabel(v)].filter(Boolean).join(' · '))}</div></div>
        <div class="trail"><div class="title2 num">${f1(v.week)}</div><div class="caption num ${cls(delta)}">${signed(delta)} vs base</div></div>
        <button class="sheet-close" data-sheet-close aria-label="Close">${icon('close', 20)}</button>
      </div>
    </header>
    <div class="sheet-body">${breakdownPanel(id)}</div>
  </section>`;
}

function openSheet(id) {
  if (sheet || !V(id)) return;
  const root = sheetRoot();
  root.innerHTML = sheetHtml(id);
  const bd = root.querySelector('.sheet-backdrop'), sh = root.querySelector('.sheet');
  sheet = { id, bd, sh, closing: false };
  document.body.classList.add('sheet-open');
  sh.getBoundingClientRect(); // commit the off-screen start position before animating in
  requestAnimationFrame(() => { bd.classList.add('open'); sh.classList.add('open'); sh.querySelector('.sheet-close').focus({ preventScroll: true }); });

  // Drag the header down to dismiss (touch / pen / mouse).
  const grab = sh.querySelector('.sheet-head');
  let y0 = null, dy = 0;
  grab.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; y0 = e.clientY; dy = 0; sh.style.transition = 'none'; grab.setPointerCapture(e.pointerId); });
  grab.addEventListener('pointermove', (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); sh.style.transform = `translateY(${dy}px)`; });
  const release = () => {
    if (y0 == null) return;
    y0 = null; sh.style.transition = '';
    if (dy > 110) closeSheet(); else sh.style.transform = '';
  };
  grab.addEventListener('pointerup', release); grab.addEventListener('pointercancel', release);
}

function closeSheet(immediate = false) {
  if (!sheet || sheet.closing) return;
  const { id, bd, sh } = sheet;
  sheet.closing = true;
  const done = () => {
    if (!sheet || sheet.sh !== sh) return;
    sheetRoot().innerHTML = '';
    document.body.classList.remove('sheet-open');
    sheet = null;
    if (!immediate) document.querySelector(`[data-why="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  };
  if (immediate) return done();
  bd.classList.remove('open');
  sh.style.transform = ''; sh.classList.remove('open');
  sh.addEventListener('transitionend', (e) => { if (e.target === sh && e.propertyName === 'transform') done(); });
  setTimeout(done, 450); // fallback: reduced motion or a missed transitionend
}

document.addEventListener('click', (e) => { if (e.target.closest('[data-sheet-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => {
  if (!sheet) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
  else if (e.key === 'Tab') { // keep focus inside the dialog
    const f = [...sheet.sh.querySelectorAll('a[href],button:not([disabled])')];
    if (!f.length) return;
    const first = f[0], last = f.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet.sh)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// ---------- render & events ----------
function render() {
  if (S.screen !== 'app') closeSheet(true);
  const html = { onboard: renderOnboard, loading: renderLoading, leagues: renderLeagues, app: renderApp }[S.screen]();
  const y = window.scrollY;
  $app.innerHTML = html;
  if (S.screen === 'app') window.scrollTo(0, y);
}

$app.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form="user"]');
  if (!form) return;
  e.preventDefault();
  S.username = form.username.value;
  lookupUser(S.username);
});

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-tab],[data-action],[data-waiverpos],[data-trademode],[data-why],[data-xw]');
  if (!el) return;
  if (el.dataset.tab) { location.hash = el.dataset.tab; return; }
  if (el.dataset.why) return openSheet(el.dataset.why);
  if (el.dataset.xw) { S.expertWeight = +el.dataset.xw; store.set('xw', S.expertWeight); applyExpert(); return render(); }
  if (el.dataset.waiverpos) return setState({ waiverPos: el.dataset.waiverpos });
  if (el.dataset.trademode) return setState({ tradeMode: el.dataset.trademode });
  const a = el.dataset.action;
  if (a === 'demo') startDemo();
  else if (a === 'league') openLeague(el.dataset.id);
  else if (a === 'signout') { store.set('league', null); setState({ screen: 'onboard', ctx: null, user: null, leagues: [], error: null }); }
  else if (a === 'refresh') openLeague(S.ctx.league.league_id);
  else if (a === 'open-trade') {
    const t = trades()[+el.dataset.i];
    S.builder = { partner: t.rosterId, give: new Set(t.give), get: new Set(t.get) };
    setState({ tradeMode: 'build' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (a === 'clear-trade') { S.builder.give.clear(); S.builder.get.clear(); render(); }
});

$app.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('li[role="button"]')) { e.preventDefault(); e.target.click(); }
});

async function importRankings(file) {
  try {
    const rows = parseRankingsCSV(await file.text());
    if (rows.length < 5) throw new Error('That file has no recognizable rankings. It needs columns like RK, PLAYER NAME, TEAM and POS.');
    const incoming = new Set(rows.map(r => r.pos));
    const prev = store.get('rankings');
    const keep = prev && prev.week === S.ctx.week ? prev.rows.filter(r => !incoming.has(r.pos)) : [];
    store.set('rankings', { week: S.ctx.week, rows: [...keep, ...rows] });
    applyExpert();
    const m = S.ctx.expertStats?.perSource.find(x => x.id === 'csv');
    S.rankMsg = { text: `Imported ${rows.length} rankings (${[...incoming].join(', ')}). ${m?.matched ?? 0} players matched${m?.unmatched ? `, ${m.unmatched} not found on Sleeper` : ''}.` };
  } catch (err) { S.rankMsg = { err: true, text: err.message }; }
  render();
}

$app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.src) { S.srcOff[t.dataset.src] = !t.checked; store.set('srcOff', S.srcOff); applyExpert(); return render(); }
  if (t.dataset.rankings !== undefined) { if (t.files[0]) importRankings(t.files[0]); return; }
  if (t.dataset.pick) {
    const set = S.builder[t.dataset.pick];
    t.checked ? set.add(t.value) : set.delete(t.value);
    render();
  } else if (t.dataset.change === 'partner') {
    S.builder = { partner: +t.value, give: S.builder.give, get: new Set() };
    render();
  } else if (t.dataset.change === 'league') {
    openLeague(t.value);
  }
});

window.addEventListener('hashchange', () => {
  S.tab = location.hash.slice(1) || 'overview';
  if (S.screen === 'app') { render(); window.scrollTo(0, 0); }
});

if (S.username) lookupUser(S.username); else render();
