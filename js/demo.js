// Deterministic sample league so the app can be explored without a Sleeper account.
import { finish } from './data.js';
import { describe } from './weather.js';
import { isDome } from './weather.js';
import { buildSlate } from './signals.js';

const TEAMS = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC',
  'LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SF','SEA','TB','TEN','WAS'];
const FIRST = ['Jalen','Marcus','Tyler','Devin','Chris','Jordan','Brandon','Aaron','Malik','Trey','Cole','Isaiah',
  'Darius','Kyle','Justin','Andre','Miles','Caleb','Nico','Drew','Elijah','Jaylen','Rashad','Logan','Bryce'];
const LAST = ['Carter','Hayes','Brooks','Mitchell','Coleman','Reed','Foster','Bennett','Ward','Price','Hughes',
  'Sanders','Barnes','Ross','Henderson','Patterson','Jenkins','Perry','Powell','Long','Russell','Griffin','Wallace'];
const NAMES = ['Gridiron Gurus','Waiver Wire Warriors','Fourth & Long','Red Zone Rebels','The Audibles',
  'Blitz Brigade','Pocket Presence','Hail Mary Heroes','End Zone Elite','Two-Minute Drill','Turn Caddie FC','Play Action'];

function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

export function demoContext() {
  const r = rng(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const week = 6;
  const players = {};
  const weekProj = {}, seasonProj = {}, seasonStats = {};
  const counts = { QB: 40, RB: 80, WR: 100, TE: 40, K: 32, DEF: 32 };
  const peak = { QB: 24, RB: 20, WR: 19, TE: 14, K: 10, DEF: 10 };
  let n = 1;
  for (const [pos, c] of Object.entries(counts)) {
    for (let i = 0; i < c; i++) {
      const id = String(n++);
      const team = pos === 'DEF' ? TEAMS[i] : pick(TEAMS);
      const tier = Math.pow(1 - i / c, 1.6);
      const rate = Math.max(1.5, peak[pos] * (0.25 + 0.75 * tier) * (0.85 + r() * 0.3));
      const roll = r();
      const injury = roll < 0.04 ? 'Out' : roll < 0.12 ? 'Questionable' : roll < 0.14 ? 'IR' : roll < 0.16 ? 'Doubtful' : null;
      players[id] = {
        id, pos, team, age: 22 + Math.floor(r() * 12), depth: 1,
        name: pos === 'DEF' ? `${team} Defense` : `${pick(FIRST)} ${pick(LAST)}`,
        injury, injuryNote: injury ? pick(['Hamstring', 'Ankle', 'Knee', 'Concussion', 'Shoulder']) : null,
      };
      const opp = pick(TEAMS.filter(t => t !== team));
      const pts = (x) => ({ rush_yd: +(x * 10).toFixed(1), gp: 1 });
      weekProj[id] = { stats: pts(rate * (0.8 + r() * 0.4)), opponent: opp, team };
      seasonProj[id] = { stats: { rush_yd: rate * (0.9 + r() * 0.2) * 170, gp: 17 } };
      const gp = injury === 'IR' ? 2 : week - 1;
      // A few unheralded players break out — prime waiver targets.
      const breakout = i > c * 0.6 && r() < 0.12 ? 3.2 : 1;
      seasonStats[id] = { pts: rate * (0.7 + r() * 0.6) * breakout * gp, games: gp };
    }
  }

  const ids = (pos) => Object.values(players).filter(p => p.pos === pos)
    .sort((a, b) => seasonProj[b.id].stats.rush_yd - seasonProj[a.id].stats.rush_yd).map(p => p.id);
  const pools = Object.fromEntries(Object.keys(counts).map(p => [p, ids(p)]));
  const need = { QB: 2, RB: 5, WR: 6, TE: 2, K: 1, DEF: 1 };
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}`, players: [], starters: [], reserve: [],
    settings: { wins: 0, losses: 0, waiver_budget_used: Math.floor(r() * 40), fpts: 0 } }));
  // Uneven roster builds create real positional needs.
  const shapes = [
    { QB: 2, RB: 3, WR: 7, TE: 2, K: 1, DEF: 1 }, // you: WR-heavy, thin at RB
    { QB: 3, RB: 6, WR: 4, TE: 1, K: 1, DEF: 1 },
    { QB: 1, RB: 5, WR: 6, TE: 3, K: 1, DEF: 1 },
    { QB: 2, RB: 6, WR: 5, TE: 2, K: 1, DEF: 1 },
  ];
  const builds = rosters.map((_, i) => shapes[i % shapes.length]);
  // Snake draft, slightly randomised so teams aren't perfectly balanced.
  for (const [pos, k] of Object.entries(need)) {
    for (let round = 0; round < 7; round++) {
      const order = round % 2 ? [...rosters].reverse() : rosters;
      for (const ro of order) {
        if (round >= builds[ro.roster_id - 1][pos]) continue;
        const pool = pools[pos];
        const idx = Math.min(pool.length - 1, Math.floor(r() * 3));
        ro.players.push(pool.splice(idx, 1)[0]);
      }
    }
  }
  const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'K', 'DEF'];
  for (const ro of rosters) {
    const by = (pos) => ro.players.filter(id => players[id].pos === pos);
    // A plausible (not optimal) saved lineup: users often leave a hurt or bye player in.
    const s = [by('QB')[0], by('RB')[0], by('RB')[1], by('WR')[0], by('WR')[1], by('TE')[0], by('RB')[2], by('WR')[2], by('K')[0], by('DEF')[0]];
    ro.starters = s;
    ro.settings.wins = Math.floor(r() * 6); ro.settings.losses = 5 - ro.settings.wins;
    ro.settings.fpts = Math.round(500 + r() * 250);
  }

  // Give some teams a hole to fill (and you a couple of lineup problems).
  const best = (ro, pos) => ro.players.filter(id => players[id].pos === pos)
    .sort((a, b) => seasonProj[b].stats.rush_yd - seasonProj[a].stats.rush_yd)[0];
  rosters.slice(1).forEach((ro, i) => {
    if (i % 3) return;
    const p = players[best(ro, ['QB', 'RB', 'WR', 'TE'][i % 4])];
    Object.assign(p, { injury: 'IR', injuryNote: 'Knee' });
  });
  const myTe = players[best(rosters[0], 'TE')];
  Object.assign(myTe, { injury: 'Out', injuryNote: 'Ankle' });
  players[rosters[0].starters[4]].team = 'KC';

  const users = rosters.map((ro, i) => ({ user_id: ro.owner_id, display_name: i === 0 ? 'you' : `manager${i + 1}`, metadata: { team_name: NAMES[i] } }));
  const league = {
    league_id: 'demo', name: 'Demo League (sample data)', season: '2026', total_rosters: 12,
    roster_positions: [...slots, 'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    scoring_settings: { rush_yd: 0.1, rec: 1 },
    settings: { waiver_type: 2, waiver_budget: 100, playoff_week_start: 15 },
  };
  const weather = {};
  for (const t of TEAMS) {
    if (isDome(t)) { weather[t] = { dome: true, summary: 'Indoors' }; continue; }
    const wx = { dome: false, tempF: Math.round(35 + r() * 40), windMph: Math.round(r() < 0.2 ? 18 + r() * 10 : r() * 12), precipMm: r() < 0.15 ? 3 : 0 };
    wx.summary = describe(wx);
    weather[t] = wx;
  }
  const dvp = Object.fromEntries(TEAMS.map(t => [t, Object.fromEntries(Object.keys(counts).map(pos => [pos, 0.84 + r() * 0.32]))]));
  // Slate: pair teams (KC and MIA are on bye). One early game is final, one live, the rest upcoming.
  const playing = TEAMS.filter(t => t !== 'KC' && t !== 'MIA');
  const DAY = 864e5, now = Date.now();
  const games = [];
  for (let i = 0; i + 1 < playing.length; i += 2) {
    const g = i / 2;
    const kickoff = g === 0 ? now - 2 * DAY + 4 * 36e5 : g === 1 ? now - 36e5 : now + DAY + (g % 3) * 3 * 36e5;
    const total = Math.round((38 + r() * 16) * 2) / 2, margin = Math.round(r() * 12 * 2) / 2;
    const fav = r() < 0.5 ? playing[i] : playing[i + 1];
    games.push({ home: playing[i], away: playing[i + 1], kickoff: new Date(kickoff).toISOString(), state: g === 0 ? 'post' : g === 1 ? 'in' : 'pre',
      indoor: isDome(playing[i]), total, margin, favorite: margin ? fav : null });
  }
  const slate = buildSlate(games);
  for (const id of Object.keys(weekProj)) { const g = slate[players[id].team]; if (g) weekProj[id].opponent = g.opp; }
  // Usage: most players steady, some risers and fallers over the last three games.
  const usage = {};
  for (const p of Object.values(players)) {
    if (!['RB', 'WR', 'TE'].includes(p.pos)) continue;
    const snap = 0.35 + r() * 0.55, tgt = p.pos === 'RB' ? 0.04 + r() * 0.08 : 0.08 + r() * 0.18, rush = p.pos === 'RB' ? 0.15 + r() * 0.5 : null;
    const t = r() < 0.12 ? 1.35 : r() < 0.24 ? 0.7 : 1 + (r() - 0.5) * 0.1;
    usage[p.id] = { games: 5, snap: { l3: Math.min(0.98, snap * t), season: snap }, tgt: { l3: tgt * t, season: tgt },
      rush: { l3: rush == null ? null : rush * t, season: rush }, tgtPerGame: Math.round(tgt * t * 35 * 10) / 10 };
  }
  // News for a handful of players, including some on your roster.
  const news = {};
  const headline = (p) => p.injury ? [`${p.name} ${p.injury === 'Out' ? 'ruled out' : 'limited in practice'} with ${String(p.injuryNote).toLowerCase()}`, 'Coach says the team will make a decision closer to kickoff.']
    : [`${p.name} expected to see an expanded role`, 'Offensive coordinator says the plan is to get him more touches.'];
  for (const id of [...rosters[0].players.slice(0, 7), ...Object.keys(players).filter(id => players[id].injury).slice(0, 4)]) {
    const [h, d] = headline(players[id]);
    news[id] = [{ headline: h, description: d, published: new Date(now - 5 * 36e5).toISOString(), url: null }];
  }
  return finish({ demo: true, slate, usage, news, league, rosters, users, players, scoring: league.scoring_settings, week, season: '2026',
    weekProj, seasonProj, seasonStats, dvp, weather, byes: { MIA: 6, KC: 6 }, myRosterId: 1 });
}
