// SF Symbols–style line icons: 24×24 grid, 1.75 stroke, round caps/joins.
const PATHS = {
  gauge: '<path d="M4.5 16a8 8 0 1 1 15 0"/><path d="M12 16l3.5-5"/><circle cx="12" cy="16" r="1.2"/>',
  lineup: '<rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  plus: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
  swap: '<path d="M7 4L3.5 7.5 7 11"/><path d="M3.5 7.5H17"/><path d="M17 13l3.5 3.5L17 20"/><path d="M20.5 16.5H7"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.2c2.3.2 4 1.6 4.5 4.3"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  football: '<ellipse cx="12" cy="12" rx="9" ry="5.5" transform="rotate(-45 12 12)"/><path d="M9.5 14.5l5-5M10.5 11l2.5 2.5M12 9.5l2.5 2.5M9 12.5l2.5 2.5"/>',
  sparkles: '<path d="M10 3.5l1.6 4.4L16 9.5l-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z"/><path d="M17.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3"/><path d="M12 13v3.5M8.5 20h7M9.5 20l.5-3.5h4l.5 3.5"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-4M11 16V8M15 16v-6M19 16V5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  dollar: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.4-1-1.4-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.2-.6-2.6-1.6M12 6.2v1.5M12 16.3v1.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.75" cy="6.5" r="1"/><circle cx="4.75" cy="12" r="1"/><circle cx="4.75" cy="17.5" r="1"/>',
  cross: '<path d="M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z"/>',
  wind: '<path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 17h7"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4.5H15"/>',
  logout: '<path d="M14 4.5H7a2.5 2.5 0 0 0-2.5 2.5v10A2.5 2.5 0 0 0 7 19.5h7"/><path d="M11 12h9.5M17 8.5l3.5 3.5-3.5 3.5"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.7 2.7L16 9.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="3"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  news: '<rect x="4" y="4.5" width="16" height="15" rx="3"/><path d="M8 9h8M8 12.5h8M8 16h4.5"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9"/><path d="M5 14v3.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V14"/>',
  slider: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
};

export function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? PATHS.info}</svg>`;
}
