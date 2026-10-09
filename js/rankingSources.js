// Expert ranking sources: how to pick the right page for a league, and how to
// parse it. Pure functions plus a fetch-injected loader, so the same code runs
// in the Netlify Function and in tests. Parsers are written against each site's
// markup/data shape as I understand it; every source reports its own status so a
// site changing its pages shows up as one failed source, not a broken app.
import { normTeam } from './signals.js';

const POS_ALIAS = { DST: 'DEF', 'D/ST': 'DEF', DEFENSE: 'DEF', PK: 'K' };
const normPos = (p) => { const u = String(p ?? '').toUpperCase().trim(); return POS_ALIAS[u] ?? u; };
const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim();

/** Rank order → positional rank for rows that only have an overall rank. */
export function withPosRanks(rows) {
  const seen = {};
  for (const r of [...rows].sort((a, b) => a.rank - b.rank)) {
    if (r.posRank != null) continue;
    seen[r.pos] = (seen[r.pos] ?? 0) + 1;
    r.posRank = seen[r.pos];
  }
  return rows;
}

/** Which ranking page matches this league (see rankingProfile in signals.js). */
export function leagueProfile(league) {
  const rec = league?.scoring_settings?.rec ?? 0;
  const rp = league?.roster_positions ?? [];
  const teams = league?.total_rosters ?? 12;
  const profile = {
    scoring: rec >= 0.75 ? 'ppr' : rec >= 0.25 ? 'half' : 'std',
    superflex: rp.includes('SUPER_FLEX') || rp.filter(s => s === 'QB').length >= 2,
    teams,
    tePremium: (league?.scoring_settings?.bonus_rec_te ?? 0) > 0,
    hasK: rp.includes('K'), hasDef: rp.includes('DEF'),
  };
  const sc = { std: 'Standard', half: 'Half-PPR', ppr: 'PPR' }[profile.scoring];
  profile.label = `${sc} · ${profile.superflex ? 'Superflex' : '1-QB'} · ${teams} teams`;
  return profile;
}

// ---------- shared JSON helpers ----------

/** Parse the JSON object that follows `marker` (e.g. "ecrData = "), honoring strings and nesting. */
export function extractJSONAfter(text, marker) {
  const m = typeof marker === 'string' ? text.indexOf(marker) : text.search(marker);
  if (m < 0) return null;
  const start = text.indexOf('{', m);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

// ---------- FantasyPros (consensus of experts, embedded as `ecrData`) ----------

export function parseFantasyPros(html) {
  const data = extractJSONAfter(html, /ecrData\s*=\s*/);
  const list = data?.players;
  if (!Array.isArray(list) || !list.length) throw new Error('ranking data not found on page');
  const rows = list.map((p, i) => {
    const pos = normPos(p.player_position_id ?? String(p.pos_rank ?? '').replace(/\d+$/, ''));
    const pr = String(p.pos_rank ?? '').match(/(\d+)$/);
    return { name: decode(p.player_name), team: normTeam(p.player_team_id), pos, rank: Number(p.rank_ecr) || i + 1, posRank: pr ? +pr[1] : null };
  }).filter(r => r.name && r.pos);
  return withPosRanks(rows);
}

const FP_PREFIX = { std: '', half: 'half-point-ppr-', ppr: 'ppr-' };
function planFantasyPros(p) {
  const base = 'https://www.fantasypros.com/nfl/rankings/';
  const flex = `${base}${FP_PREFIX[p.scoring]}${p.superflex ? 'superflex' : 'flex'}.php`;
  const out = [{ kind: 'flex', candidates: [flex] }];
  if (!p.superflex) out.push({ kind: 'qb', candidates: [`${base}qb.php`] });
  if (p.hasK) out.push({ kind: 'k', candidates: [`${base}k.php`] });
  if (p.hasDef) out.push({ kind: 'dst', candidates: [`${base}dst.php`] });
  return out;
}

// ---------- CBS Sports (expert rankings tables) ----------

export function parseCBS(html, kind) {
  const rows = [];
  const re = /CellPlayerName-name[^>]*>([\s\S]{0,300}?)<\/(?:span|div)>[\s\S]{0,600}?CellPlayerName-position[^>]*>\s*([A-Za-z/]{1,4})\s*<[\s\S]{0,300}?CellPlayerName-team[^>]*>\s*([A-Za-z]{2,4})\s*</g;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    rows.push({ name: decode(m[1]), team: normTeam(m[3]), pos: normPos(m[2]), rank: n, posRank: null });
  }
  if (!rows.length) {
    // Defense/kicker tables sometimes use a short-name cell with no position span.
    const re2 = /CellPlayerName--short[\s\S]{0,400}?<a[^>]*>([^<]+)<\/a>/g;
    while ((m = re2.exec(html))) { n++; rows.push({ name: decode(m[1]), team: null, pos: kind === 'DST' ? 'DEF' : kind, rank: n, posRank: null }); }
  }
  if (!rows.length) throw new Error('no ranking rows found (page may be client-rendered)');
  return withPosRanks(rows);
}

function planCBS(p) {
  const base = 'https://www.cbssports.com/fantasy/football/rankings/';
  const fmt = { std: 'standard', half: 'half-ppr', ppr: 'ppr' }[p.scoring];
  const positions = ['QB', 'RB', 'WR', 'TE', ...(p.hasK ? ['K'] : []), ...(p.hasDef ? ['DST'] : [])];
  return positions.map(pos => ({
    kind: pos,
    // Tried in order until one returns rows; the first is the page layout I'd expect.
    candidates: [`${base}${fmt}/${pos}/`, `${base}${fmt}/${pos}/weekly/`, `${base}${pos}/`],
  }));
}

// ---------- Draft Sharks (embedded app data; mostly premium) ----------

function findPlayerArray(node, depth = 0) {
  if (!node || depth > 8 || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    const sample = node.slice(0, 5);
    const nm = (o) => o?.name ?? o?.player_name ?? o?.playerName ?? o?.full_name;
    const ps = (o) => o?.position ?? o?.pos ?? o?.player_position;
    const rk = (o) => o?.rank ?? o?.overall_rank ?? o?.ovr_rank ?? o?.ecr ?? o?.adp;
    if (node.length >= 20 && sample.every(o => o && typeof o === 'object' && nm(o) && ps(o) && rk(o) != null)) return node;
    for (const x of node.slice(0, 50)) { const r = findPlayerArray(x, depth + 1); if (r) return r; }
    return null;
  }
  for (const v of Object.values(node)) { const r = findPlayerArray(v, depth + 1); if (r) return r; }
  return null;
}

export function parseDraftSharks(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let data = null;
  if (m) { try { data = JSON.parse(m[1]); } catch { /* fall through */ } }
  data ??= extractJSONAfter(html, /__INITIAL_STATE__\s*=\s*/);
  const arr = data && findPlayerArray(data);
  if (!arr) throw new Error('no ranking data in page (rankings are likely premium or rendered client-side)');
  const rows = arr.map((o, i) => ({
    name: decode(o.name ?? o.player_name ?? o.playerName ?? o.full_name),
    team: normTeam(o.team ?? o.team_abbr ?? o.teamAbbr),
    pos: normPos(o.position ?? o.pos ?? o.player_position),
    rank: Number(o.rank ?? o.overall_rank ?? o.ovr_rank ?? o.ecr ?? o.adp) || i + 1,
    posRank: null,
  })).filter(r => r.name && r.pos);
  return withPosRanks(rows);
}

function planDraftSharks(p) {
  const base = 'https://www.draftsharks.com/rankings';
  const fmt = { std: 'standard', half: 'half-ppr', ppr: 'ppr' }[p.scoring];
  return [{ kind: 'all', candidates: [`${base}/${fmt}${p.superflex ? '/superflex' : ''}`, `${base}/${fmt}`, base] }];
}

// ---------- Fantasy Football Calculator (ADP JSON API) ----------
// FFC's "rankings" are ADP-ordered. Its public JSON API is more robust than
// scraping the page. This is draft-position value, so it gets a lower weight.

export function parseFFC(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  const list = data?.players;
  if (!Array.isArray(list) || !list.length) throw new Error('no players in ADP response');
  const rows = list.map((p, i) => ({
    name: decode(p.name), team: normTeam(p.team), pos: normPos(p.position),
    rank: Number(p.adp) || i + 1, posRank: null,
  })).filter(r => r.name && r.pos);
  return withPosRanks(rows);
}

function planFFC(p, { season }) {
  const fmt = p.superflex ? '2qb' : { std: 'standard', half: 'half-ppr', ppr: 'ppr' }[p.scoring];
  const teams = [8, 10, 12, 14].reduce((a, b) => (Math.abs(b - p.teams) < Math.abs(a - p.teams) ? b : a));
  return [{ kind: 'adp', candidates: [`https://fantasyfootballcalculator.com/api/v1/adp/${fmt}?teams=${teams}&year=${season}&position=all`] }];
}

export const SOURCES = [
  { id: 'fp', name: 'FantasyPros', weight: 1, home: 'https://www.fantasypros.com/nfl/rankings/half-point-ppr-flex.php', plan: planFantasyPros, parse: parseFantasyPros },
  { id: 'cbs', name: 'CBS Sports', weight: 1, home: 'https://www.cbssports.com/fantasy/football/rankings/', plan: planCBS, parse: parseCBS },
  { id: 'ds', name: 'Draft Sharks', weight: 1, home: 'https://www.draftsharks.com/rankings', plan: planDraftSharks, parse: parseDraftSharks },
  { id: 'ffc', name: 'Fantasy Football Calculator (ADP)', weight: 0.5, home: 'https://fantasyfootballcalculator.com/rankings/standard', plan: planFFC, parse: parseFFC },
];

/**
 * Fetch and parse one source for a league profile. `fetchFn` is injected
 * (global fetch in the Netlify Function, a stub in tests). Never throws:
 * returns { rows, tried, error }.
 */
export async function loadSource(src, profile, ctx, fetchFn) {
  const rows = [], tried = [];
  await Promise.all(src.plan(profile, ctx).map(async (item) => {
    for (const url of item.candidates) {
      try {
        const res = await fetchFn(url, { headers: { 'user-agent': 'FantasyCaddie/1.0 (personal fantasy tool)', accept: 'text/html,application/json' }, signal: AbortSignal.timeout(7000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const got = src.parse(await res.text(), item.kind);
        if (!got.length) throw new Error('no rows');
        rows.push(...got);
        tried.push({ url, ok: true, count: got.length });
        return;
      } catch (e) { tried.push({ url, ok: false, error: e.message ?? String(e) }); }
    }
  }));
  const seen = new Set();
  const uniq = rows.filter(r => { const k = `${r.name}|${r.pos}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const failures = tried.filter(t => !t.ok);
  const error = uniq.length ? null : (failures.at(-1)?.error ?? 'no data');
  return { id: src.id, name: src.name, weight: src.weight, home: src.home, rows: uniq, tried, error };
}
