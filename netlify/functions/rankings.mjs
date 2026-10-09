// GET /.netlify/functions/rankings?scoring=half&superflex=0&teams=12&season=2026&k=1&dst=1
// Fetches expert rankings server-side (those sites don't allow browser CORS),
// picking pages that match the league, and returns per-source rows + status.
// Only fixed hosts are ever contacted; query params are validated to enums.
import { SOURCES, loadSource, debugSource } from '../../js/rankingSources.js';

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...extra },
});

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const scoring = ['std', 'half', 'ppr'].includes(q.get('scoring')) ? q.get('scoring') : 'half';
  const teams = Math.min(Math.max(parseInt(q.get('teams') ?? '12', 10) || 12, 4), 32);
  const season = /^20\d\d$/.test(q.get('season') ?? '') ? q.get('season') : String(new Date().getFullYear());
  const profile = { scoring, superflex: q.get('superflex') === '1', teams, hasK: q.get('k') !== '0', hasDef: q.get('dst') !== '0', tePremium: q.get('tep') === '1' };

  // ?debug=<source id> shows what each page returned and how the parsers handled it.
  const dbg = q.get('debug');
  if (dbg) {
    const src = SOURCES.find(x => x.id === dbg);
    if (!src) return json({ error: `unknown source; use one of ${SOURCES.map(x => x.id).join(', ')}` }, 400);
    return json(await debugSource(src, profile, { season }, fetch), 200, { 'cache-control': 'no-store' });
  }

  const sources = await Promise.all(SOURCES.map(s => loadSource(s, profile, { season }, fetch)));
  return json({ profile, fetchedAt: new Date().toISOString(), sources }, 200, {
    'cache-control': 'public, max-age=300',
    'netlify-cdn-cache-control': 'public, s-maxage=1800, stale-while-revalidate=3600',
  });
};
