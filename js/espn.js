// ESPN's public site API: keyless and CORS-enabled. Used for betting lines,
// kickoff times/state, and player news. Failures are non-fatal: callers get
// null and the app simply drops those signals.
import { getJSON } from './sleeper.js';
import { parseScoreboard, parseNews } from './signals.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

export async function fetchSlate(season, week) {
  try {
    const json = await getJSON(`${BASE}/scoreboard?week=${week}&seasontype=2&dates=${season}`, { ttl: 3 * 60e3 });
    const games = parseScoreboard(json);
    return games.length ? games : null;
  } catch { return null; }
}

export async function fetchNews() {
  try {
    const json = await getJSON(`${BASE}/news?limit=100`, { ttl: 15 * 60e3 });
    const items = parseNews(json);
    return items.length ? items : null;
  } catch { return null; }
}
