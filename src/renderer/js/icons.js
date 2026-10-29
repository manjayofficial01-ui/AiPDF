/** Inline stroke-based icon set (24×24 grid). Keeps the app dependency-free. */
const P = {
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  undo: 'M3 7v6h6M3.5 13a9 9 0 1 0 2.6-6.4',
  redo: 'M21 7v6h-6M20.5 13a9 9 0 1 1-2.6-6.4',
  pages: 'M4 3h7v18H4zM13 3h7v18h-7z',
  comments: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  bookmark: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
  ai: 'M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7zM18.6 15.2l.85 2.3 2.3.85-2.3.85-.85 2.3-.85-2.3-2.3-.85 2.3-.85z',
  highlight: 'M4 21h16M6 16.5l8-8 3.5 3.5-8 8H6z',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14',
  strikeout: 'M5 20h14M8.5 6.5a4.5 4.5 0 0 1 7 0M15.5 11.5a4.5 4.5 0 0 1-7 2',
  squiggly: 'M3 18c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2M5 12h14M4 6h16',
  note: 'M5 3h14v11l-4 4H5zM15 18v4l4-4',
  callout: 'M4 4h16v10H9l-5 5z',
  textbox: 'M4 5h16v14H4zM7 9h10M7 12h10M7 15h6',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 5c5 0 9 3.1 9 7s-4 7-9 7-9-3.1-9-7 4-7 9-7z',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5M12 5h7v7',
  ink: 'M4 20l4-1 10.5-10.5-3-3L5 16zM14.5 5.5l3 3',
  eraser: 'M6 21h12M3.5 16.5l5.5-5.5 6.5 6.5-4 4H7.5z',
  stamp: 'M6 21h12M5 16h14l-2-7H7zM9 9V4h6v5',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5L13 16l3-3 4 4M15 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  signature: 'M3 18c3 0 3-9 6-9s3 9 6 9 3-6 6-6M3 18h18',
  redact: 'M3 9h18v7H3zM3 9l2-2h14l2 2M3 16l2 2h14l2-2',
  whiteout: 'M3 9h18v7H3z',
  editText: 'M4 20h16M5 15l6-11 3 5.5 3-3-4 8.5z',
  measure: 'M3 7h18M3 7v3M21 7v3M6 4v6M12 5v4M18 4v6',
  merge: 'M12 3v6M9 7l3 3 3-3M12 15v6M9 19l3-3 3 3M4 12h16',
  split: 'M12 3v18M7 7l-3 5 3 5M17 7l3 5-3 5',
  rotate: 'M20.5 12a8.5 8.5 0 1 1-2.5-6M21 4v5h-5',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3M12 15v2',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z',
  moon: 'M21 13.2A9 9 0 1 1 10.8 3a7 7 0 0 0 10.2 10.2z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 13l4 4L19 7',
  chevronUp: 'M6 15l6-6 6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  file: 'M6 2h8l4 4v16H6zM14 2v5h5',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  translate: 'M4 5h11M9.5 3v2c0 4.5-2.5 7.5-5.5 9M6 11c1.2 3.3 4.5 5.5 8 6.5M13.5 20.5l4.5-9.5 4.5 9.5M14.8 17.4h6.4',
  wand: 'M5 19L19 5M15 5h4v4M5 15v4h4',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14M15 5v14',
  crop: 'M6 2v16h16M2 6h16v16',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  upload: 'M12 21V9M7 13l5-5 5 5M4 3h16',
  palette: 'M12 21a9 9 0 1 1 9-9c0 2-1.6 3-3.5 3H16a2 2 0 0 0-1.4 3.4A1.9 1.9 0 0 1 12 21zM8 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM16 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L11.5 5M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l2-2',
  attach: 'M21 11l-8 8a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l8-8',
  form: 'M4 4h16v16H4zM7 9h10M7 13h10M7 17h5',
  checkbox: 'M4 5h16v14H4zM8 12l3 3 5-6',
  radio: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  dropdown: 'M4 5h16v14H4zM14 11l-2 2-2-2',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  zoomIn: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35M11 8v6M8 11h6',
  zoomOut: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  present: 'M3 4h18v12H3zM8 20h8M12 16v4',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  scissors: 'M7 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 23a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.5 19.5M8.5 4.5L20 20',
  key: 'M15 7a4 4 0 1 0-3.9 5L3 20v1h3l1-1v-2h2v-2h2l1.2-1.2A4 4 0 1 0 15 7zM16.5 8.5h.01',
  sparkle: 'M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z',
  brain: 'M9 3a4 4 0 0 0-4 4 3 3 0 0 0-1 5.8V16a3 3 0 0 0 3 3h1V3zM15 3a4 4 0 0 1 4 4 3 3 0 0 1 1 5.8V16a3 3 0 0 1-3 3h-1V3z',
  scan: 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16',
  font: 'M5 20L12 4l7 16M7.5 13h9M17 20h2',
  // Page-in-page: reads as "scale this page up/down" at 16px.
  resize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M4 4l16 16M9.5 9.5h5v5h-5z',
  filter: 'M3 5h18l-7 8v6l-4-2v-4z',
  polygon: 'M12 3l8 6-3 10H7L4 9z',
  polyline: 'M4 17l5-8 4 4 7-9M4 17h16',
  cloud: 'M7 18h10a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 6.6 10 3.6 3.6 0 0 0 7 18z',
  areaHighlight: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  roundRect: 'M5 9V7a2 2 0 0 1 2-2h2M19 9V7a2 2 0 0 0-2-2h-2M5 15v2a2 2 0 0 0 2 2h2M19 15v2a2 2 0 0 1-2 2h-2',
  // Standard arrow cursor — the Select tool's default. Drawn pointed up-left
  // (the convention every OS uses).
  cursor: 'M5.5 3.2l11 6.4-4.4 1.1 1.4 5-2.5 .7-1.4-5-3.8 3z',
  caret: 'M5 20V4l7 7-7 7h14',
  speaker: 'M4 9v6h4l5 4V5L8 9zM16 9.5a4 4 0 0 1 0 5M19 7a8 8 0 0 1 0 10',
  duplicate: 'M8 8h12v12H8zM4 16V4h12',
  reverse: 'M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4',
  replace: 'M4 7h11l-3-3M20 17H9l3 3M20 7v0M4 17v0',
  compare: 'M9 3v18M15 3v18M4 8h4M16 16h4M4 16h4M16 8h4',
  flatten: 'M4 6h16v12H4zM4 12h16M8 9h8v6H8z',
  accessibility: 'M12 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM7 8h10M12 8v5M12 13l-3 7M12 13l3 7',
  reset: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  import: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  readAloud: 'M4 9v6h4l5 4V5L8 9zM16 9.5a4 4 0 0 1 0 5M19 7a8 8 0 0 1 0 10',
  dupe2: 'M8 8h12v12H8zM4 16V4h12',
  hand: 'M7.5 11.5V5.4c0-.9.65-1.6 1.45-1.6s1.45.7 1.45 1.6V10m0-6.4c0-.9.65-1.6 1.45-1.6s1.45.7 1.45 1.6V10m0-5.6c0-.9.65-1.6 1.45-1.6s1.45.7 1.45 1.6v6.6m0-4.4c0-.9.65-1.6 1.45-1.6s1.45.7 1.45 1.6v6.9c0 4.4-2.75 7.4-6.7 7.4-3.15 0-4.5-1.5-6.3-4.9l-1.85-3.6c-.5-.95-.15-2.05.7-2.5.8-.45 1.8-.2 2.35.6l1.4 2V8',

  // Export formats. Every Convert target shared the generic `download` glyph, so
  // five different outputs were indistinguishable on the ribbon. Stroke-only and
  // single-path, like the rest of the set.
  html: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
  markdown: 'M2.5 6.5h19v11h-19zM6 15V9l3 3.5L12 9v6',
  epub: 'M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5zM12 6.5v13',
  rtf: 'M6 3h8l4 4v14H6zM14 3v4h4M9 17l2.5-6 2.5 6M10 15h3',
  word: 'M6 3h8l4 4v14H6zM14 3v4h4M8.5 12l1.4 5 1.6-3.6 1.6 3.6 1.4-5',
  plaintext: 'M4 6h16M4 10h16M4 14h12M4 18h8',
  // Stirling pack: compress (arrows into a box), booklet (open book + fold),
  // unlock (open shackle). Stroke-only, single-path, 24×24 grid.
  compress: 'M12 3v4M12 17v4M4 12h4M16 12h4M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3',
  book: 'M12 5C10 4 7 3.5 4 4v15c3-.5 6 0 8 1.5V5zM12 5c2-1 5-1.5 8-1v15c-3-.5-6 0-8 1.5',
  unlock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 5.7-1.3M12 15v2',
  // Read-aloud player: play / pause / stop (stroke-only, 24×24 grid).
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M9 5v14M15 5v14',
  stop: 'M7.5 7.5h9v9h-9z',
  // Diagonal ruler with tick marks (View ▸ Show rulers).
  ruler: 'M3.5 16.5L16.5 3.5l4 4L7.5 20.5zM9 15l1.5 1.5M12 12l1.5 1.5M15 9l1.5 1.5M18 6l1.5 1.5',
  // Marquee: corner brackets of a selection rectangle (Area Direct Edit).
  marquee: 'M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M8 8h8v8H8z',
  // Favourite (star) fonts.
  star: 'M12 3.2l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.4l5.9-.8z',
  // Menu / overflow affordances used by the redesigned ribbon and the
  // quick-access customiser.
  menu: 'M4 7h16M4 12h16M4 17h16',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  pin: 'M9 3h6l-1 6 4 3v2H6v-2l4-3zM12 14v7',
  // Keyboard — the shortcut reference panel in Settings.
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M8 14h8',
};

const cache = new Map();

export function svgIcon(name, size = 16, strokeWidth = 1.7) {
  const key = name + '|' + size + '|' + strokeWidth;
  if (cache.has(key)) return cache.get(key);
  let d = P[name];
  if (d == null) {
    // Loud in dev: a silently-wrong icon hides this bug class. Still renderable.
    console.warn(`[icons] svgIcon: unknown icon name "${name}" — falling back to "info". Add the glyph to the set in icons.js.`);
    d = P.info;
  }
  const s = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
  cache.set(key, s);
  return s;
}

export { P as ICON_PATHS };
