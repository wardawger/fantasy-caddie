// Assembles everything the engine needs for one league and week.
import { sleeper, indexByPlayer } from './sleeper.js';
import { gameWeather } from './weather.js';
import { fetchSlate, fetchNews } from './espn.js';
import { buildSlate, slateAverage, buildUsage, newsByPlayer, aggregateRankings } from './signals.js';
import { addVOR, buildDvP, buildValues, fantasyPoints, LAST_WEEK } from './engine.js';

export async function loadLeagueContext(leagueId, onStep = () => {}) {
  onStep('Loading league');
  const [state, league, rosters, users] = await Promise.all([
    sleeper.state(), sleeper.league(leagueId), sleeper.rosters(leagueId), sleeper.users(leagueId),
  ]);
  const season = league.season;
  const week = Math.min(Math.max(state.season_type === 'regular' ? state.week : (state.season === season ? LAST_WEEK : 1), 1), LAST_WEEK);

  onStep('Loading players');
  const players = await sleeper.players();

  onStep('Loading projections & stats');
  const pastWeeks = Array.from({ length: week - 1 }, (_, i) => i + 1);
  const [weekProjRaw, seasonProjRaw, schedule, slateGames, newsItems, ...pastRaw] = await Promise.all([
    sleeper.projections(season, week).catch(() => []),
    sleeper.seasonProjections(season).catch(() => []),
    sleeper.schedule(season).catch(() => []),
    fetchSlate(season, week),
    fetchNews(),
    ...pastWeeks.map(w => sleeper.weekStats(season, w).catch(() => [])),
  ]);
  const weekProj = indexByPlayer(weekProjRaw);
  const seasonProj = indexByPlayer(seasonProjRaw);
  const pastStats = pastRaw.map(indexByPlayer);
  const scoring = league.scoring_settings ?? {};

  const seasonStats = {};
  for (const wk of pastStats) {
    for (const [id, row] of Object.entries(wk)) {
      const pts = fantasyPoints(row.stats, scoring);
      if (!row.stats?.gp && !pts) continue;
      const s = (seasonStats[id] ??= { pts: 0, games: 0 });
      s.pts += pts; s.games += 1;
    }
  }

  const byes = byeWeeks(schedule);
  onStep('Checking game-day weather');
  const games = (schedule ?? []).filter(g => g.week === week).map(g => ({ home: g.home, away: g.away, date: g.date }));
  const weather = await gameWeather(games).catch(() => ({}));

  return finish({ league, rosters, users, players, scoring, week, season, weekProj, seasonProj, seasonStats,
    dvp: buildDvP(pastStats, players, scoring), weather, byes, games,
    slate: slateGames ? buildSlate(slateGames) : null, newsItems, usage: buildUsage(pastStats, players) });
}

export function finish(ctx) {
  ctx.slateAvg = slateAverage(ctx.slate);
  ctx.news ??= ctx.newsItems ? newsByPlayer(ctx.newsItems, ctx.players) : null;
  // Expert sets (fetched sources + imported CSV) only count for the week they were pulled for.
  const sets = (ctx.expertSets ?? []).filter(x => x.week === ctx.week && x.rows?.length && x.enabled !== false);
  const agg = sets.length ? aggregateRankings(sets, ctx.players) : null;
  ctx.expert = agg?.map ?? null;
  ctx.expertStats = agg ? { matched: Object.keys(agg.map).length, perSource: agg.perSource } : null;
  ctx.values = buildValues(ctx);
  ctx.sources = {
    projections: Object.keys(ctx.weekProj ?? {}).length > 0,
    lines: Object.values(ctx.slate ?? {}).some(g => g.implied != null),
    kickoffs: Object.keys(ctx.slate ?? {}).length > 0,
    usage: Object.keys(ctx.usage ?? {}).length > 0,
    news: !!ctx.news && Object.keys(ctx.news).length > 0,
    weather: Object.keys(ctx.weather ?? {}).length > 0,
    experts: ctx.expertStats?.matched ?? 0,
  };
  ctx.replacement = addVOR(ctx.values, ctx.players, ctx.league);
  ctx.userById = Object.fromEntries((ctx.users ?? []).map(u => [u.user_id, u]));
  ctx.teamName = (rosterId) => {
    const r = ctx.rosters.find(x => x.roster_id === rosterId);
    const u = r && ctx.userById[r.owner_id];
    return u?.metadata?.team_name || u?.display_name || `Team ${rosterId}`;
  };
  ctx.avatar = (rosterId) => {
    const r = ctx.rosters.find(x => x.roster_id === rosterId);
    const a = r && ctx.userById[r.owner_id]?.avatar;
    return a ? `https://sleepercdn.com/avatars/thumbs/${a}` : null;
  };
  return ctx;
}

function byeWeeks(schedule) {
  const teams = new Set();
  const playing = {};
  for (const g of schedule ?? []) {
    teams.add(g.home); teams.add(g.away);
    (playing[g.week] ??= new Set()).add(g.home).add(g.away);
  }
  const byes = {};
  for (const [wk, set] of Object.entries(playing)) {
    for (const t of teams) if (!set.has(t) && +wk <= 14) byes[t] = +wk;
  }
  return byes;
}
