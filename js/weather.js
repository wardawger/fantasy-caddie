// Game-day weather from Open-Meteo (free, keyless, CORS-enabled).
// Keyed by home team; both teams in a game share the forecast.

// [lat, lon, indoors] — domes and fixed roofs are treated as neutral.
const STADIUMS = {
  ARI: [33.528, -112.263, true], ATL: [33.755, -84.401, true], BAL: [39.278, -76.623], BUF: [42.774, -78.787],
  CAR: [35.226, -80.853], CHI: [41.862, -87.617], CIN: [39.095, -84.516], CLE: [41.506, -81.700],
  DAL: [32.748, -97.093, true], DEN: [39.744, -105.020], DET: [42.340, -83.046, true], GB: [44.501, -88.062],
  HOU: [29.685, -95.411, true], IND: [39.760, -86.164, true], JAX: [30.324, -81.637], KC: [39.049, -94.484],
  LV: [36.091, -115.184, true], LAC: [33.953, -118.339, true], LAR: [33.953, -118.339, true], MIA: [25.958, -80.239],
  MIN: [44.974, -93.258, true], NE: [42.091, -71.264], NO: [29.951, -90.081, true], NYG: [40.813, -74.074],
  NYJ: [40.813, -74.074], PHI: [39.901, -75.168], PIT: [40.447, -80.016], SF: [37.403, -121.970],
  SEA: [47.595, -122.332], TB: [27.976, -82.503], TEN: [36.166, -86.771], WAS: [38.908, -76.864],
};

export function isDome(team) { return !!STADIUMS[team]?.[2]; }

/** games: [{home, away, date: 'YYYY-MM-DD'}] → team -> {summary, windMph, precipMm, tempF, dome} */
export async function gameWeather(games) {
  const out = {};
  await Promise.all(games.map(async (g) => {
    const st = STADIUMS[g.home];
    if (!st) return;
    let wx;
    if (st[2]) {
      wx = { dome: true, summary: 'Indoors' };
    } else {
      const daysOut = (new Date(g.date) - Date.now()) / 864e5;
      if (!g.date || daysOut > 14 || daysOut < -1) return;
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${st[0]}&longitude=${st[1]}` +
          `&hourly=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m&temperature_unit=fahrenheit` +
          `&wind_speed_unit=mph&precipitation_unit=mm&timezone=auto&start_date=${g.date}&end_date=${g.date}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const h = (await res.json()).hourly;
        // Average over a typical 1pm–4pm window (local time).
        const idx = [13, 14, 15, 16];
        const avg = (arr) => idx.reduce((t, i) => t + (arr[i] ?? 0), 0) / idx.length;
        wx = { dome: false, tempF: Math.round(avg(h.temperature_2m)), precipMm: +avg(h.precipitation).toFixed(1),
          windMph: Math.round(avg(h.wind_speed_10m)), gustMph: Math.round(Math.max(...idx.map(i => h.wind_gusts_10m[i] ?? 0))) };
        wx.summary = describe(wx);
      } catch { return; }
    }
    out[g.home] = wx;
    out[g.away] = wx;
  }));
  return out;
}

export function describe(wx) {
  if (wx.dome) return 'Indoors';
  const bits = [`${wx.tempF}°F`];
  if (wx.windMph >= 12) bits.push(`wind ${wx.windMph} mph`);
  if (wx.precipMm >= 2) bits.push('heavy rain/snow');
  else if (wx.precipMm >= 0.5) bits.push('showers');
  return bits.join(', ');
}
