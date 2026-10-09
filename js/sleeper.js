// Sleeper API client. The public API is read-only, keyless and CORS-enabled,
// so everything runs in the browser. Projections/stats come from the
// undocumented api.sleeper.com endpoints the Sleeper app itself uses.

const V1 = 'https://api.sleeper.app/v1';
const API = 'https://api.sleeper.com';
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

const memo = new Map();

export async function getJSON(url, { ttl = 10 * 60e3, persist = false } = {}) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  if (persist) {
    const stored = readStore(url);
    if (stored && Date.now() - stored.t < ttl) { memo.set(url, stored); return stored.v; }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper request failed (${res.status}): ${url}`);
  const v = await res.json();
  const entry = { t: Date.now(), v };
  memo.set(url, entry);
  if (persist) writeStore(url, entry);
  return v;
}

function readStore(key) {
  try { return JSON.parse(localStorage.getItem('tc:' + key)); } catch { return null; }
}
function writeStore(key, entry) {
  try { localStorage.setItem('tc:' + key, JSON.stringify(entry)); } catch { /* quota: memory cache only */ }
}

const posQuery = POSITIONS.map(p => `position[]=${p}`).join('&');

export const sleeper = {
  state: () => getJSON(`${V1}/state/nfl`, { ttl: 30 * 60e3 }),
  user: (name) => getJSON(`${V1}/user/${encodeURIComponent(name)}`),
  leagues: (userId, season) => getJSON(`${V1}/user/${userId}/leagues/nfl/${season}`),
  league: (id) => getJSON(`${V1}/league/${id}`),
  rosters: (id) => getJSON(`${V1}/league/${id}/rosters`, { ttl: 60e3 }),
  users: (id) => getJSON(`${V1}/league/${id}/users`),
  matchups: (id, week) => getJSON(`${V1}/league/${id}/matchups/${week}`, { ttl: 60e3 }),

  // ~5 MB raw; trimmed to the fields we use and cached for a day.
  async players() {
    const key = `${V1}/players/nfl#trim2`;
    const stored = readStore(key);
    if (stored && Date.now() - stored.t < 4 * 36e5) return stored.v; // injury status lives here, so refresh a few times a day
    const raw = await getJSON(`${V1}/players/nfl`, { ttl: 4 * 36e5 });
    const out = {};
    for (const [id, p] of Object.entries(raw)) {
      const pos = p.fantasy_positions?.[0] ?? p.position;
      if (!POSITIONS.includes(pos)) continue;
      if (!p.active && pos !== 'DEF') continue;
      out[id] = {
        id, pos, team: p.team ?? null,
        name: pos === 'DEF' ? `${p.first_name} ${p.last_name}` : (p.full_name ?? `${p.first_name} ${p.last_name}`),
        age: p.age ?? null,
        injury: p.injury_status ?? null,
        injuryNote: [p.injury_body_part, p.injury_notes].filter(Boolean).join(' – ') || null,
        depth: p.depth_chart_order ?? null,
        espnId: p.espn_id ?? null,
      };
    }
    writeStore(key, { t: Date.now(), v: out });
    return out;
  },

  projections: (season, week) =>
    getJSON(`${API}/projections/nfl/${season}/${week}?season_type=regular&${posQuery}`, { ttl: 30 * 60e3 }),
  seasonProjections: (season) =>
    getJSON(`${API}/projections/nfl/${season}?season_type=regular&${posQuery}`, { ttl: 6 * 36e5, persist: true }),
  weekStats: (season, week) =>
    getJSON(`${API}/stats/nfl/${season}/${week}?season_type=regular&${posQuery}`, { ttl: 36e5 }),
  schedule: (season) =>
    getJSON(`${API}/schedule/nfl/regular/${season}`, { ttl: 864e5 }),
};

// Normalise the projection/stat array shape ({player_id, stats, opponent, ...})
// into a map keyed by player id.
export function indexByPlayer(rows) {
  const out = {};
  for (const r of rows ?? []) {
    if (!r?.player_id) continue;
    out[r.player_id] = { stats: r.stats ?? {}, opponent: r.opponent ?? null, team: r.team ?? null };
  }
  return out;
}
