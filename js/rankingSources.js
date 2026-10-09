// Expert ranking sources: how to pick the right page for a league, and how to
// parse it. Pure functions plus a fetch-injected loader, so the same code runs
// in the Netlify Function and in tests. Parsers are written against each site's
// markup/data shape as I understand it; every source reports its own status so a
// site changing its pages shows up as one failed source, not a broken app.
import { normTeam } from './signals.js';

const POS_ALIAS = { DST: 'DEF', 'D/ST': 'DEF', DEFENSE: 'DEF', PK: 'K' };
const normPos = (p) => { const u = String(p ?? '').toUpperCase().trim(); return POS_ALIAS[u] ?? u; };
const decode = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

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

// ---------- CBS Sports (server-rendered FantasyRankingsTable) ----------
// Pages (verified against the live site): /fantasy/football/rankings/{ppr|standard}/{flex|QB|K|DST}/weekly/
// Flex rows carry "RB12"-style position ranks; position pages carry only the overall order.
// CBS has no half-PPR pages, so half-PPR leagues use the PPR rankings.

const NICK = { Cardinals: 'ARI', Falcons: 'ATL', Ravens: 'BAL', Bills: 'BUF', Panthers: 'CAR', Bears: 'CHI', Bengals: 'CIN', Browns: 'CLE', Cowboys: 'DAL', Broncos: 'DEN', Lions: 'DET', Packers: 'GB', Texans: 'HOU', Colts: 'IND', Jaguars: 'JAX', Chiefs: 'KC', Raiders: 'LV', Chargers: 'LAC', Rams: 'LAR', Dolphins: 'MIA', Vikings: 'MIN', Patriots: 'NE', Saints: 'NO', Giants: 'NYG', Jets: 'NYJ', Eagles: 'PHI', Steelers: 'PIT', '49ers': 'SF', Seahawks: 'SEA', Buccaneers: 'TB', Titans: 'TEN', Commanders: 'WAS' };

export function parseCBS(html, kind) {
  const rows = [];
  const trs = html.match(/<tr[^>]*class="[^"]*FantasyRankingsTable-row(?!--header)[^"]*"[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  for (const tr of trs) {
    const cell = (c) => tr.match(new RegExp(`td--${c}"[^>]*>([\\s\\S]*?)<\\/td>`))?.[1];
    const rank = parseInt(decode(cell('rank')), 10);
    // The name span holds both "Jahmyr " and a mobile-only initial ("J. ") before the surname.
    const nameHtml = tr.match(/FantasyRankingsTable-playerName[^>]*>([\s\S]*?)(?:<\/a>|<span class="FantasyRankingsTable-icons|<\/div>)/)?.[1] ?? '';
    const name = decode(nameHtml.replace(/<span[^>]*FirstInitial[^>]*>[\s\S]*?<\/span>/gi, ''));
    if (!name || !Number.isFinite(rank)) continue;
    let team = decode(tr.match(/FantasyRankingsTable-teamPosition[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '');
    const pm = decode(cell('pos') ?? '').match(/^([A-Z]+)(\d+)?$/);
    let pos = pm ? normPos(pm[1]) : normPos(kind);
    // Defenses have no team span: use the logo file name (…/HOU.png), else the nickname.
    if (pos === 'DEF') team = tr.match(/logos\/\d+x\d+\/([A-Za-z]{2,4})\.png/)?.[1] ?? NICK[name] ?? team;
    if (!['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(pos)) continue;
    rows.push({ name, team: normTeam(team), pos, rank, posRank: pm?.[2] ? +pm[2] : null });
  }
  if (rows.length) return withPosRanks(rows);
  for (const f of [() => parseTables(html, kind), () => parseEmbeddedJSON(html)]) { try { return f(); } catch { /* next */ } }
  throw new Error('no ranking rows found (page layout may have changed)');
}

function planCBS(p) {
  const base = 'https://www.cbssports.com/fantasy/football/rankings/';
  const fmt = p.scoring === 'std' ? 'standard' : 'ppr';
  const mk = (kind, path) => ({ kind, candidates: [`${base}${fmt}/${path}/weekly/`] });
  return [mk('flex', 'flex'), mk('QB', 'QB'), ...(p.hasK ? [mk('K', 'K')] : []), ...(p.hasDef ? [mk('DST', 'DST')] : [])];
}

// ---------- Draft Sharks (embedded app data; mostly premium) ----------

const NAME_KEYS = ['name', 'player_name', 'playerName', 'full_name', 'fullName', 'displayName', 'display_name'];
const POS_KEYS = ['position', 'pos', 'player_position', 'positionAbbr', 'position_abbr', 'positionAbbreviation'];
const RANK_KEYS = ['rank', 'overall_rank', 'overallRank', 'ovr_rank', 'ecr', 'adp', 'ranking', 'rank_ecr', 'projectedRank'];
const TEAM_KEYS = ['team', 'team_abbr', 'teamAbbr', 'teamAbbreviation', 'abbreviation', 'team_id'];
const pick = (o, keys) => { for (const k of keys) { const v = o?.[k]; if (v != null && typeof v !== 'object') return v; } return null; };

/** Find the biggest array of player-like objects anywhere in a parsed JSON blob. */
export function findPlayerArray(node, depth = 0, minLen = 10) {
  if (!node || depth > 10 || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    const sample = node.slice(0, 5);
    if (node.length >= minLen && sample.every(o => o && typeof o === 'object' && pick(o, NAME_KEYS) && pick(o, POS_KEYS) && pick(o, RANK_KEYS) != null)) return node;
    for (const x of node.slice(0, 60)) { const r = findPlayerArray(x, depth + 1, minLen); if (r) return r; }
    return null;
  }
  let best = null;
  for (const v of Object.values(node)) {
    const r = findPlayerArray(v, depth + 1, minLen);
    if (r && (!best || r.length > best.length)) best = r;
  }
  return best;
}

const rowsFromArray = (arr) => withPosRanks(arr.map((o, i) => ({
  name: decode(pick(o, NAME_KEYS)), team: normTeam(pick(o, TEAM_KEYS)), pos: normPos(pick(o, POS_KEYS)),
  rank: Number(pick(o, RANK_KEYS)) || i + 1, posRank: null,
})).filter(r => r.name && r.pos));

/** Look through every <script> for JSON (script type json, ld+json, or `x = {...}` assignments) containing a player list. */
export function parseEmbeddedJSON(html) {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, , body] of scripts) {
    const text = body.trim();
    if (text.length < 200) continue;
    const candidates = [];
    if (text[0] === '{' || text[0] === '[') { try { candidates.push(JSON.parse(text)); } catch { /* not pure JSON */ } }
    const assign = text.match(/(?:window\.[\w$.]+|(?:var|let|const)\s+[\w$]+)\s*=\s*(?=[{[])/);
    if (assign) {
      const j = extractJSONAfter(text.slice(assign.index + assign[0].length - 1), /^/);
      if (j) candidates.push(j);
    }
    for (const c of candidates) {
      const arr = findPlayerArray(c);
      if (arr) { const rows = rowsFromArray(arr); if (rows.length >= 10) return rows; }
    }
  }
  throw new Error('no embedded ranking data found');
}

/** Generic HTML-table parser: finds the table with the most rows that look like "rank, player, [pos], [team]". */
export function parseTables(html, kind) {
  const POS_RE = /\b(QB|RB|WR|TE|PK|K|DST|D\/ST|DEF)\b/i;
  let best = [];
  for (const t of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    let cols = null;
    const got = [];
    for (const tr of t.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = [...tr.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => ({ tag: m[1].toLowerCase(), text: decode(m[2]) }));
      if (!cells.length) continue;
      if (cells.every(c => c.tag === 'th')) { cols = cells.map(c => c.text.toLowerCase()); continue; }
      const idx = (re) => (cols ? cols.findIndex(c => re.test(c)) : -1);
      let iRank = idx(/^(rk|rank|#|ovr|overall|ecr)/), iName = idx(/player|name/), iPos = idx(/^pos/), iTeam = idx(/^team/);
      if (iRank < 0) iRank = cells.findIndex(c => /^\d{1,3}$/.test(c.text));
      if (iName < 0) iName = cells.findIndex((c, i) => i !== iRank && /[A-Za-z]{2,}[ .'-][A-Za-z]{2,}/.test(c.text));
      if (iRank < 0 || iName < 0) continue;
      let name = cells[iName].text, pos = iPos >= 0 ? cells[iPos].text : null, team = iTeam >= 0 ? cells[iTeam].text : null;
      // "Josh Allen QB BUF" style cells carry position and team inline.
      const m = name.match(/^(.*?)\s+(QB|RB|WR|TE|PK|K|DST|D\/ST|DEF)\s+([A-Z]{2,4})$/i);
      if (m) { name = m[1]; pos ??= m[2]; team ??= m[3]; }
      pos = normPos((pos && POS_RE.test(pos) ? pos.match(POS_RE)[1] : null) ?? (kind === 'DST' ? 'DEF' : /^(QB|RB|WR|TE|K|DEF|DST)$/.test(kind ?? '') ? kind : ''));
      if (!pos || !name) continue;
      got.push({ name, team: team ? normTeam(team.replace(/[^A-Za-z]/g, '').slice(0, 4)) : null, pos, rank: Number(cells[iRank].text), posRank: null });
    }
    if (got.length > best.length) best = got;
  }
  if (best.length < 8) throw new Error('no ranking table found');
  return withPosRanks(best);
}

// Draft Sharks server-renders only the top 25 rows of each ranking page (the rest is premium), and
// these are rest-of-season rankings rather than weekly ones. Pages (verified): /rankings/{ppr|half-ppr}/{qb|rb|wr|te|k|def}.
// There is no standard-scoring page, so standard leagues use half-PPR.
export function parseDraftSharks(html, kind) {
  const rows = [];
  for (const tr of html.match(/<tr[^>]*class="[^"]*player-row[^"]*"[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const rank = parseInt(decode(tr.match(/rank-index[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ''), 10);
    const first = tr.match(/first-name="([^"]*)"/)?.[1] ?? '', last = tr.match(/last-name="([^"]*)"/)?.[1] ?? '';
    const spot = tr.match(/pos-roster-spot="([A-Z/]+)"[^>]*>\s*(\d+)\s*</);
    const team = tr.match(/player-details-group__team-name[^>]*>\s*([A-Za-z]{2,4})\s*</)?.[1] ?? null;
    const name = decode(`${first} ${last}`);
    if (!name || !Number.isFinite(rank)) continue;
    rows.push({ name, team: normTeam(team), pos: normPos(spot?.[1] ?? kind), rank, posRank: spot ? +spot[2] : null });
  }
  if (rows.length) return withPosRanks(rows);
  for (const f of [() => parseEmbeddedJSON(html), () => parseTables(html, kind)]) { try { return f(); } catch { /* next */ } }
  throw new Error('no ranking data in page (rankings are likely premium or rendered client-side)');
}

function planDraftSharks(p) {
  const fmt = p.scoring === 'ppr' ? 'ppr' : 'half-ppr';
  const mk = (kind, path) => ({ kind, candidates: [`https://www.draftsharks.com/rankings/${fmt}/${path}`] });
  return [mk('QB', 'qb'), mk('RB', 'rb'), mk('WR', 'wr'), mk('TE', 'te'), ...(p.hasK ? [mk('K', 'k')] : []), ...(p.hasDef ? [mk('DEF', 'def')] : [])];
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
  { id: 'cbs', name: 'CBS Sports', weight: 1, home: 'https://www.cbssports.com/fantasy/football/rankings/ppr/flex/weekly/', plan: planCBS, parse: parseCBS },
  { id: 'ds', name: 'Draft Sharks (top 25 per position, rest of season)', weight: 0.5, home: 'https://www.draftsharks.com/rankings', plan: planDraftSharks, parse: parseDraftSharks },
  { id: 'ffc', name: 'Fantasy Football Calculator (ADP)', weight: 0.25, home: 'https://fantasyfootballcalculator.com/rankings/standard', plan: planFFC, parse: parseFFC },
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

/**
 * Diagnostics for a source: what each candidate URL returned and what the
 * parsers made of it. Used by `?debug=<id>` on the function so a failing site
 * can be diagnosed from one deploy. Only fetches the same fixed URLs as loadSource.
 */
export async function debugSource(src, profile, ctx, fetchFn) {
  const out = [];
  const urls = src.plan(profile, ctx).flatMap(i => i.candidates.map(url => ({ url, kind: i.kind })));
  await Promise.all(urls.map(async ({ url, kind }) => {
    const rec = { url, kind };
    try {
      const res = await fetchFn(url, { headers: { 'user-agent': 'FantasyCaddie/1.0 (personal fantasy tool)', accept: 'text/html,application/json' }, signal: AbortSignal.timeout(7000) });
      const body = await res.text();
      Object.assign(rec, { status: res.status, contentType: res.headers?.get?.('content-type') ?? null, bytes: body.length });
      rec.title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim().slice(0, 120);
      rec.tables = (body.match(/<table/gi) ?? []).length;
      rec.scripts = [...body.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].map(m => ({ attrs: m[1].trim().slice(0, 80), len: m[2].length }))
        .filter(x => x.len > 500).slice(0, 12);
      const classes = {};
      for (const m of body.matchAll(/class="([^"]*(?:Player|Rank|rank|player)[^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (/Player|Rank|rank|player/.test(c)) classes[c] = (classes[c] ?? 0) + 1;
      rec.classes = Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 15);
      const hit = body.search(/Mahomes|Chase|Allen|Jefferson|McCaffrey|Lamb/);
      rec.sample = hit >= 0 ? body.slice(Math.max(0, hit - 500), hit + 900) : body.slice(0, 1200);
      try { rec.parsed = src.parse(body, kind).length; } catch (e) { rec.parseError = e.message; }
    } catch (e) { rec.error = e.message ?? String(e); }
    out.push(rec);
  }));
  return { source: src.id, profile, results: out };
}
