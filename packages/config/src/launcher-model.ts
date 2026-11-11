/**
 * The launcher's pure logic: data shapes, the layout of the panel, the
 * selection, text editing, the fallback search and the merging of results.
 * Nothing here touches the compositor, so tests run it in plain Node
 * (tests/launcher-model.test.ts). The drawing is in ./launcher.tsx.
 *
 * All sizes are logical px, measured from the approved mock
 * (shojiwm-setup/docs/research/launcher-mockup/launcher.html) rendered at
 * 2560x1440 (there the panel is 1082 x 800, 1020 wide inside its padding),
 * then scaled to 88% (`SCALE`).
 */

/** An app, as shoji-find sends it. */
export interface LauncherApp {
  /** The desktop file id. */
  id: string;
  name: string;
  /** An absolute icon file path. */
  icon: string;
  /** The command line. */
  exec: string;
}

export type LauncherActionKind = "exec" | "open" | "copy" | "url";

export interface LauncherAction {
  kind: LauncherActionKind;
  value: string;
}

/** One search result. */
export interface LauncherItem {
  id: string;
  title: string;
  sub: string;
  /** An absolute icon file path, or "". */
  icon: string;
  chip?: string;
  /** [start, end) offsets into `sub` to highlight. */
  highlight?: [number, number][];
  action: LauncherAction;
}

export type SectionKind = "top" | "apps" | "files" | "settings" | "math" | "meaning" | "web";

export interface LauncherSection {
  kind: SectionKind;
  items: LauncherItem[];
}

export interface LauncherResults {
  id: number;
  q: string;
  sections: LauncherSection[];
}

export interface HomeData {
  recommended: LauncherApp[];
  pinned: LauncherApp[];
}

// ---------------------------------------------------------------- geometry

/**
 * The whole launcher is drawn at 88% of the mock's size. Every length below
 * is the mock's value times SCALE, rounded to whole px so edges and text
 * stay sharp (the layout shrinks, not a texture).
 */
export const SCALE = 0.88;
/** A mock length at the launcher's scale, in whole px. */
export const px = (mock: number) => Math.round(mock * SCALE);
/** A mock font size at the launcher's scale (fractional is fine for text). */
export const font = (mock: number) => Math.round(mock * SCALE * 10) / 10;

const BORDER = 1;
const PAD_X = px(30);
const PAD_TOP = px(26);
const PAD_BOTTOM = px(20);

/** App tiles: 8 columns with small gaps. */
export const COLUMNS = 8;
export const TILE_WIDTH = px(124);
export const TILE_HEIGHT = px(100);
export const TILE_GAP = px(4);
export const TILE_RADIUS = px(22);
export const TILE_ICON = px(52);
export const TILE_ICON_TOP = px(13);
export const TILE_LABEL_TOP = px(72);
export const TILE_LABEL_HEIGHT = px(19);

/** The left edge (panel x) and width of the content: 8 tiles wide. */
export const CONTENT_X = BORDER + PAD_X;
export const CONTENT_WIDTH = COLUMNS * TILE_WIDTH + (COLUMNS - 1) * TILE_GAP;

/** The panel's border box. */
export const PANEL_WIDTH = CONTENT_WIDTH + 2 * (PAD_X + BORDER);
export const PANEL_RADIUS = px(30);
/** The panel's centre sits at this fraction of the output's height. */
export const PANEL_CENTER_Y = 0.47;

/** The search pill. */
export const SEARCH = { x: CONTENT_X, y: BORDER + PAD_TOP, width: CONTENT_WIDTH, height: px(62) };
export const SEARCH_ICON = { x: px(26), size: px(24) };
export const SEARCH_TEXT_X = px(64);
export const SEARCH_FONT = font(23);

/** A section title ("Recommended"). */
const HEADER_MARGIN_TOP = px(20);
const HEADER_HEIGHT = px(18);
const HEADER_MARGIN_BOTTOM = px(8);
/** "Apps" under Recommended has a little more room above it. */
const HOME_SECOND_HEADER_MARGIN = px(22);
export const HEADER_X = CONTENT_X + px(10);
export const HEADER_LINE = HEADER_HEIGHT;
/** The body's top padding. */
const BODY_PAD_TOP = px(4);
/** Room around the content for the glow of a selected entry. */
const GLOW_ROOM = px(22);

/** The default view's height (2 + 3 rows of tiles), fixed while typing. */
const HOME_HEIGHT =
  BODY_PAD_TOP + HEADER_MARGIN_TOP + HEADER_HEIGHT + HEADER_MARGIN_BOTTOM +
  2 * TILE_HEIGHT + TILE_GAP +
  HOME_SECOND_HEADER_MARGIN + HEADER_HEIGHT + HEADER_MARGIN_BOTTOM +
  3 * TILE_HEIGHT + 2 * TILE_GAP + px(20);

/**
 * The scroll area. It reaches past the content on each side so a glow at
 * the edge is not cut off. Entries are placed in panel x and in y from the
 * top of this area.
 */
export const BODY = {
  x: CONTENT_X - GLOW_ROOM,
  y: SEARCH.y + SEARCH.height,
  width: CONTENT_WIDTH + 2 * GLOW_ROOM,
  height: HOME_HEIGHT,
};

/** Result rows: pills with a title, or a title over a subtitle. */
export const ROW_HEIGHT = px(48);
export const ROW_HEIGHT_WITH_SUB = px(59);
const ROW_GAP = 2;
/** The top hit and the math answer: a big pill. */
export const PILL_HEIGHT = px(78);
/** "searching inside your files..." */
export const NOTE_HEIGHT = px(35);
/** Inside a row or pill. */
export const ROW = {
  padLeft: px(18),
  padRight: px(18),
  icon: px(30),
  gap: px(14),
  titleFont: font(17),
  titleLine: px(23),
  subFont: font(13.5),
  subLine: px(18),
};
export const PILL = {
  padLeft: px(14),
  padRight: px(26),
  icon: px(56),
  gap: px(14),
  titleFont: font(22),
  titleLine: px(30),
  subFont: font(13.5),
  subLine: px(18),
};

/** The bottom row: the account pill and the 5 power lights. */
export const LIGHT_BUTTON = px(46);
export const POWER_Y = BODY.y + BODY.height + px(14);
export const PANEL_HEIGHT = POWER_Y + LIGHT_BUTTON + PAD_BOTTOM + BORDER;
export const ACCOUNT = { x: CONTENT_X, y: POWER_Y + 1, width: px(130), height: px(44), avatar: px(34), nameX: px(49) };
/**
 * The power lights. Shut down (the last) is as big as the account's avatar;
 * the other four are a little smaller.
 */
export const LIGHT_SIZE = px(30);
export const SHUTDOWN_LIGHT_SIZE = ACCOUNT.avatar;
export const lightSize = (index: number) => (index === 4 ? SHUTDOWN_LIGHT_SIZE : LIGHT_SIZE);
/** About half the light, with the same parity so it sits on whole pixels. */
export const lightIcon = (index: number) => 2 * Math.round(lightSize(index) / 4);
/**
 * How much a light (or the avatar) of `size` px grows on hover: about 20%,
 * rounded so it ends a whole, even number of pixels wider. A grown image with
 * edges between pixels is drawn blurred; on whole pixels it stays sharp.
 */
export const hoverGrow = (size: number) => (2 * Math.round(size * 0.1)) / size;
/**
 * The hover glow image of a `size` px light: the light plus room for the
 * halo, 3 px on each side once grown, so it too ends on whole pixels.
 * tools/make-hover-glow.py draws it with the same room.
 */
export const HOVER_GLOW_ROOM = 3;
export const glowSize = (size: number) => size + (2 * HOVER_GLOW_ROOM) / (1 + hoverGrow(size));
export const LIGHT_PITCH = LIGHT_BUTTON + px(6);
export const FIRST_LIGHT_X = CONTENT_X + CONTENT_WIDTH - 5 * LIGHT_BUTTON - 4 * (LIGHT_PITCH - LIGHT_BUTTON);

/** Where the panel goes on an output (global logical px, whole pixels). */
export function panelRect(output: { x: number; y: number; width: number; height: number }) {
  return {
    x: Math.round(output.x + (output.width - PANEL_WIDTH) / 2),
    y: Math.round(output.y + output.height * PANEL_CENTER_Y - PANEL_HEIGHT / 2),
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
  };
}

/** The title and subtitle of a row or pill: one block, centred vertically. */
export function rowTextTops(height: number, pill: boolean, hasSub: boolean) {
  const look = pill ? PILL : ROW;
  const block = look.titleLine + (hasSub ? look.subLine : 0);
  const title = Math.round((height - block) / 2);
  return { title, sub: title + look.titleLine };
}

// ---------------------------------------------------------------- layout

export type EntryKind = "tile" | "row" | "pill";

/** Something that can be selected and activated. */
export interface Entry {
  kind: EntryKind;
  /** Panel x, body y (before scrolling). */
  x: number;
  y: number;
  width: number;
  height: number;
  section: SectionKind | "recommended" | "pinned";
  item: LauncherItem;
  /** The app behind a tile (pin and unpin), if any. */
  app?: LauncherApp;
}

export interface Header {
  text: string;
  y: number;
}

export interface Note {
  text: string;
  y: number;
}

export interface Layout {
  headers: Header[];
  notes: Note[];
  entries: Entry[];
  /** The content height, padding included. */
  height: number;
}

/** An app as a result item that runs it. */
export function appItem(app: LauncherApp): LauncherItem {
  return { id: app.id, title: app.name, sub: "", icon: app.icon, action: { kind: "exec", value: app.exec } };
}

/** The default view: Recommended (2 rows) and Apps (3 rows). */
export function layoutHome(home: HomeData): Layout {
  const headers: Header[] = [];
  const entries: Entry[] = [];
  let y = BODY_PAD_TOP;
  const grid = (apps: LauncherApp[], rows: number, section: "recommended" | "pinned") => {
    apps.slice(0, rows * COLUMNS).forEach((app, index) => {
      entries.push({
        kind: "tile",
        ...tilePosition(index, y),
        width: TILE_WIDTH,
        height: TILE_HEIGHT,
        section,
        item: appItem(app),
        app,
      });
    });
    y += rows * TILE_HEIGHT + (rows - 1) * TILE_GAP;
  };
  y += HEADER_MARGIN_TOP;
  headers.push({ text: "Recommended", y });
  y += HEADER_HEIGHT + HEADER_MARGIN_BOTTOM;
  grid(home.recommended, 2, "recommended");
  y += HOME_SECOND_HEADER_MARGIN;
  headers.push({ text: "Apps", y });
  y += HEADER_HEIGHT + HEADER_MARGIN_BOTTOM;
  grid(home.pinned, 3, "pinned");
  return { headers, notes: [], entries, height: y + 8 };
}

function tilePosition(index: number, top: number) {
  return {
    x: CONTENT_X + (index % COLUMNS) * (TILE_WIDTH + TILE_GAP),
    y: top + Math.floor(index / COLUMNS) * (TILE_HEIGHT + TILE_GAP),
  };
}

const SECTION_TITLES: Partial<Record<SectionKind, string>> = {
  apps: "Apps",
  files: "Files",
  settings: "Settings",
  meaning: "By meaning",
  web: "Web",
};

/** At most this many app tiles in the results (2 rows). */
export const MAX_RESULT_TILES = 16;
/** At most this many rows per section. */
export const MAX_SECTION_ROWS = 6;

/**
 * The results while typing, in the order the sections come. `meaningPending`
 * shows "By meaning" with a note until those results arrive.
 */
export function layoutResults(sections: LauncherSection[], meaningPending = false): Layout {
  const headers: Header[] = [];
  const notes: Note[] = [];
  const entries: Entry[] = [];
  let y = BODY_PAD_TOP;
  const header = (text: string) => {
    y += HEADER_MARGIN_TOP;
    headers.push({ text, y });
    y += HEADER_HEIGHT + HEADER_MARGIN_BOTTOM;
  };
  const rows = (section: SectionKind, items: LauncherItem[]) => {
    items.slice(0, MAX_SECTION_ROWS).forEach((item, index) => {
      if (index > 0) {
        y += ROW_GAP;
      }
      const height = item.sub ? ROW_HEIGHT_WITH_SUB : ROW_HEIGHT;
      entries.push({ kind: "row", x: CONTENT_X, y, width: CONTENT_WIDTH, height, section, item });
      y += height;
    });
  };
  let shown = sections.filter((section) => section.items.length > 0);
  if (meaningPending && !shown.some((section) => section.kind === "meaning")) {
    shown = insertBeforeWeb(shown, { kind: "meaning", items: [] });
  }
  for (const section of shown) {
    switch (section.kind) {
      case "top":
      case "math":
        for (const item of section.items.slice(0, 1)) {
          if (entries.length > 0) {
            y += ROW_GAP;
          }
          entries.push({ kind: "pill", x: CONTENT_X, y, width: CONTENT_WIDTH, height: PILL_HEIGHT, section: section.kind, item });
          y += PILL_HEIGHT;
        }
        break;
      case "apps": {
        header(SECTION_TITLES.apps!);
        const tiles = section.items.slice(0, MAX_RESULT_TILES);
        tiles.forEach((item, index) => {
          entries.push({ kind: "tile", ...tilePosition(index, y), width: TILE_WIDTH, height: TILE_HEIGHT, section: "apps", item });
        });
        const lines = Math.ceil(tiles.length / COLUMNS);
        y += lines * TILE_HEIGHT + (lines - 1) * TILE_GAP;
        break;
      }
      default:
        header(SECTION_TITLES[section.kind] ?? section.kind);
        if (section.items.length === 0) {
          notes.push({ text: "searching inside your files...", y });
          y += NOTE_HEIGHT;
        } else {
          rows(section.kind, section.items);
        }
    }
  }
  if (entries.length === 0 && notes.length === 0) {
    notes.push({ text: "Nothing found", y: y + 30 });
    y += 30 + NOTE_HEIGHT;
  }
  return { headers, notes, entries, height: y + 8 };
}

function insertBeforeWeb(sections: LauncherSection[], section: LauncherSection): LauncherSection[] {
  const web = sections.findIndex((entry) => entry.kind === "web");
  return web < 0 ? [...sections, section] : [...sections.slice(0, web), section, ...sections.slice(web)];
}

/** The entry under a point (panel x, body y after scrolling), or -1. */
export function entryAt(entries: readonly Entry[], x: number, y: number): number {
  return entries.findIndex(
    (entry) => x >= entry.x && x < entry.x + entry.width && y >= entry.y && y < entry.y + entry.height,
  );
}

/** The scroll offset that keeps entry `index` inside the body. */
export function scrollToShow(entry: Entry | undefined, scroll: number, contentHeight: number): number {
  const max = Math.max(0, contentHeight - BODY.height);
  if (!entry) {
    return Math.min(scroll, max);
  }
  // Room for the glow of a selected entry.
  const margin = 8;
  let next = scroll;
  if (entry.y - margin < next) {
    next = entry.y - margin;
  }
  if (entry.y + entry.height + margin > next + BODY.height) {
    next = entry.y + entry.height + margin - BODY.height;
  }
  // Near the top, show the top: the first section's title too.
  if (next < px(60)) {
    next = 0;
  }
  return Math.max(0, Math.min(max, next));
}

// ---------------------------------------------------------------- selection

export type Direction = "Left" | "Right" | "Up" | "Down";

/**
 * Move the selection. Left and Right step through the list; Up and Down go
 * to the next line of entries (a row of tiles, or a row), to the entry
 * nearest in x: the same column in the grid.
 */
export function moveSelection(entries: readonly Pick<Entry, "x" | "y" | "width">[], current: number, direction: Direction): number {
  if (entries.length === 0) {
    return 0;
  }
  const from = Math.max(0, Math.min(entries.length - 1, current));
  if (direction === "Left") {
    return Math.max(0, from - 1);
  }
  if (direction === "Right") {
    return Math.min(entries.length - 1, from + 1);
  }
  const here = entries[from];
  const lines = [...new Set(entries.map((entry) => entry.y))].sort((a, b) => a - b);
  const line = lines.indexOf(here.y) + (direction === "Down" ? 1 : -1);
  if (line < 0 || line >= lines.length) {
    return from;
  }
  const centre = here.x + here.width / 2;
  let best = from;
  let bestDistance = Infinity;
  entries.forEach((entry, index) => {
    if (entry.y !== lines[line]) {
      return;
    }
    const distance = Math.abs(entry.x + entry.width / 2 - centre);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * The bottom row as places to move the selection to: the account, then the
 * 5 lights. It is always the last line, below any content.
 */
export const BOTTOM_LINE_Y = 1e6;
export function bottomEntries(): Pick<Entry, "x" | "y" | "width">[] {
  return [
    { x: ACCOUNT.x, y: BOTTOM_LINE_Y, width: ACCOUNT.width },
    ...Array.from({ length: 5 }, (_, index) => ({
      x: FIRST_LIGHT_X + index * LIGHT_PITCH,
      y: BOTTOM_LINE_Y,
      width: LIGHT_BUTTON,
    })),
  ];
}

// ---------------------------------------------------------------- text

export interface TextState {
  text: string;
  /** The caret, in UTF-16 code units from the start. */
  caret: number;
}

export interface KeyModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  super?: boolean;
}

/** US layout: what Shift makes of a key. */
const SHIFTED: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?", "`": "~",
};

/** xkb keysym names of printable keys that are not one character. */
const KEYSYM_CHARS: Record<string, string> = {
  space: " ", minus: "-", equal: "=", bracketleft: "[", bracketright: "]", backslash: "\\",
  semicolon: ";", apostrophe: "'", comma: ",", period: ".", slash: "/", grave: "`",
  exclam: "!", at: "@", numbersign: "#", dollar: "$", percent: "%", asciicircum: "^", ampersand: "&",
  asterisk: "*", parenleft: "(", parenright: ")", underscore: "_", plus: "+", colon: ":", quotedbl: "\"",
  less: "<", greater: ">", question: "?", braceleft: "{", braceright: "}", bar: "|", asciitilde: "~",
  KP_Add: "+", KP_Subtract: "-", KP_Multiply: "*", KP_Divide: "/", KP_Decimal: ".", KP_Space: " ",
  KP_0: "0", KP_1: "1", KP_2: "2", KP_3: "3", KP_4: "4", KP_5: "5", KP_6: "6", KP_7: "7", KP_8: "8", KP_9: "9",
};

/** The character a key types, or null (a key like Escape, or with Ctrl). */
export function keyChar(key: string, modifiers: KeyModifiers = {}): string | null {
  if (modifiers.ctrl || modifiers.alt || modifiers.super) {
    return null;
  }
  const base = KEYSYM_CHARS[key] ?? ([...key].length === 1 ? key : null);
  if (base === null) {
    return null;
  }
  if (!modifiers.shift || key.startsWith("KP_")) {
    return base;
  }
  return SHIFTED[base] ?? base.toUpperCase();
}

/** Where the word before the caret starts (Ctrl+Backspace). */
function wordStart(text: string, caret: number): number {
  let index = caret;
  while (index > 0 && /\s/.test(text[index - 1])) {
    index--;
  }
  while (index > 0 && !/\s/.test(text[index - 1])) {
    index--;
  }
  return index;
}

/**
 * Edit the query with a key. Returns the new state, or null when the key
 * does not edit text (arrows, Enter, Escape go to the launcher).
 */
export function editText(state: TextState, key: string, modifiers: KeyModifiers = {}): TextState | null {
  const { text, caret } = state;
  switch (key) {
    case "BackSpace": {
      if (caret === 0) {
        return state;
      }
      const start = modifiers.ctrl ? wordStart(text, caret) : caret - 1;
      return { text: text.slice(0, start) + text.slice(caret), caret: start };
    }
    case "Delete":
    case "KP_Delete":
      return caret >= text.length ? state : { text: text.slice(0, caret) + text.slice(caret + 1), caret };
    case "Home":
    case "KP_Home":
      return { text, caret: 0 };
    case "End":
    case "KP_End":
      return { text, caret: text.length };
  }
  if (modifiers.ctrl && (key === "u" || key === "U")) {
    return { text: "", caret: 0 };
  }
  const char = keyChar(key, modifiers);
  if (char === null) {
    return null;
  }
  return { text: text.slice(0, caret) + char + text.slice(caret), caret: caret + char.length };
}

// ---------------------------------------------------------------- search

/**
 * A simple fuzzy match, as in the mock: every letter of the query, in order.
 * 3 = the text starts with the query, 2 = contains it, 1 = letters in order,
 * -1 = no match.
 */
export function fuzzyScore(text: string, query: string): number {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let index = 0;
  for (const char of lower) {
    if (char === q[index]) {
      index++;
    }
  }
  if (index < q.length) {
    return -1;
  }
  return lower.startsWith(q) ? 3 : lower.includes(q) ? 2 : 1;
}

/** Apps whose name matches, best first (a stable sort keeps the list order on ties). */
export function filterApps(apps: readonly LauncherApp[], query: string): LauncherApp[] {
  const q = query.trim();
  if (!q) {
    return [];
  }
  return apps
    .map((app, order) => ({ app, order, score: fuzzyScore(app.name, q) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.app);
}

/**
 * Work out a sum like "19*4+2" (+ - * / and brackets). Returns null for
 * anything else; never runs code.
 */
export function evaluateMath(source: string): number | null {
  const text = source.replace(/\s+/g, "");
  if (!/^[\d+\-*/().]+$/.test(text) || !/\d/.test(text) || !/[+\-*/]/.test(text)) {
    return null;
  }
  let index = 0;
  const peek = () => text[index];
  const expression = (): number => {
    let value = term();
    while (peek() === "+" || peek() === "-") {
      const op = text[index++];
      const right = term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const term = (): number => {
    let value = factor();
    while (peek() === "*" || peek() === "/") {
      const op = text[index++];
      const right = factor();
      value = op === "*" ? value * right : value / right;
    }
    return value;
  };
  const factor = (): number => {
    if (peek() === "-") {
      index++;
      return -factor();
    }
    if (peek() === "+") {
      index++;
      return factor();
    }
    if (peek() === "(") {
      index++;
      const value = expression();
      if (peek() !== ")") {
        throw new Error("missing )");
      }
      index++;
      return value;
    }
    const match = /^\d+(\.\d+)?|^\.\d+/.exec(text.slice(index));
    if (!match) {
      throw new Error("number expected");
    }
    index += match[0].length;
    return Number(match[0]);
  };
  try {
    const value = expression();
    if (index !== text.length || !Number.isFinite(value)) {
      return null;
    }
    // 0.1+0.2 shows 0.3, not 0.30000000000000004.
    return Number(value.toPrecision(12));
  } catch {
    return null;
  }
}

/** Searches that look like a sentence also search inside files. */
export function wantsMeaning(query: string): boolean {
  return query.trim().split(/\s+/).filter((word) => word.length > 2).length >= 2;
}

/** A web search for the query. */
export function webItem(query: string): LauncherItem {
  const q = query.trim();
  return {
    id: "web",
    title: `Search the web for "${q}"`,
    sub: "",
    icon: "",
    action: { kind: "url", value: `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  };
}

/** The results built in the config, while shoji-find does not answer. */
export function fallbackResults(apps: readonly LauncherApp[], query: string, id = 0): LauncherResults {
  const sections: LauncherSection[] = [];
  const math = evaluateMath(query);
  if (math !== null) {
    sections.push({
      kind: "math",
      items: [{ id: "math", title: String(math), sub: `${query.trim()}   Enter copies it`, icon: "", action: { kind: "copy", value: String(math) } }],
    });
  }
  const found = filterApps(apps, query);
  if (found.length > 0) {
    sections.push({ kind: "top", items: [appItem(found[0])] });
    if (found.length > 1) {
      sections.push({ kind: "apps", items: found.slice(1, 1 + COLUMNS).map(appItem) });
    }
  }
  if (query.trim()) {
    sections.push({ kind: "web", items: [webItem(query)] });
  }
  return { id, q: query, sections };
}

/**
 * Take a `launcher.results` message. A reply for an older query is dropped.
 * A second reply with the same id (the "meaning" section, a moment later)
 * replaces the sections it carries and keeps the others.
 */
export function mergeResults(
  current: LauncherResults | null,
  incoming: LauncherResults,
  latestId: number,
): LauncherResults | null {
  if (incoming.id !== latestId) {
    return current;
  }
  if (!current || current.id !== incoming.id) {
    return incoming;
  }
  let sections = [...current.sections];
  for (const section of incoming.sections) {
    const index = sections.findIndex((entry) => entry.kind === section.kind);
    if (index >= 0) {
      sections[index] = section;
    } else if (section.kind === "meaning") {
      sections = insertBeforeWeb(sections, section);
    } else {
      sections.push(section);
    }
  }
  return { ...current, sections };
}

/** Is this a well-formed results message? */
export function parseResults(value: unknown): LauncherResults | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<LauncherResults>;
  if (typeof raw.id !== "number" || !Array.isArray(raw.sections)) {
    return null;
  }
  const sections = raw.sections
    .filter((section): section is LauncherSection => !!section && typeof section.kind === "string" && Array.isArray(section.items))
    .map((section) => ({ kind: section.kind, items: section.items.filter(isItem) }));
  return { id: raw.id, q: typeof raw.q === "string" ? raw.q : "", sections };
}

function isItem(value: unknown): value is LauncherItem {
  const item = value as LauncherItem;
  return !!item && typeof item.title === "string" && !!item.action && typeof item.action.value === "string";
}

export function parseApps(value: unknown): LauncherApp[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (app): app is LauncherApp => !!app && typeof app.name === "string" && typeof app.exec === "string",
  ).map((app) => ({ id: String(app.id ?? app.name), name: app.name, icon: String(app.icon ?? ""), exec: app.exec }));
}

/**
 * A desktop file's command line without its field codes (%U, %f, ...): the
 * launcher opens apps with no file.
 */
export function stripFieldCodes(exec: string): string {
  return exec
    .replace(/%[fFuUdDnNickvm]/g, "")
    .replace(/%%/g, "%")
    .replace(/\s+/g, " ")
    .trim();
}

/** A subtitle cut into plain and highlighted parts, at most `maxMarks` highlights. */
export function splitHighlights(
  text: string,
  ranges: readonly [number, number][] | undefined,
  maxMarks = 2,
): { text: string; mark: boolean }[] {
  const parts: { text: string; mark: boolean }[] = [];
  let at = 0;
  const sorted = [...(ranges ?? [])]
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])
    .slice(0, maxMarks);
  for (const [rawStart, rawEnd] of sorted) {
    const start = Math.max(at, Math.min(text.length, rawStart));
    const end = Math.max(start, Math.min(text.length, rawEnd));
    if (start > at) {
      parts.push({ text: text.slice(at, start), mark: false });
    }
    if (end > start) {
      parts.push({ text: text.slice(start, end), mark: true });
    }
    at = end;
  }
  if (at < text.length) {
    parts.push({ text: text.slice(at), mark: false });
  }
  return parts;
}

// ---------------------------------------------------------------- key repeat

/**
 * How many repeats a held key has earned `elapsedMs` after it went down:
 * none during the delay, one at the end of it, then `ratePerSecond`, speeding
 * up evenly to twice that rate over the next second (a long hold crosses the
 * grid quickly).
 */
export function repeatsDue(elapsedMs: number, delayMs: number, ratePerSecond: number): number {
  if (elapsedMs < delayMs) {
    return 0;
  }
  const t = elapsedMs - delayMs;
  // The distance covered at a speed going from 1 to 2 over 1000 ms, then 2.
  const distance = t <= 1000 ? t + (t * t) / 2000 : 1500 + 2 * (t - 1000);
  return 1 + Math.floor((ratePerSecond * distance) / 1000);
}

// ---------------------------------------------------------------- motion

/**
 * The motion of the approved mock, "Subtle" setting
 * (shojiwm-setup/docs/research/launcher-mockup/motion.html). All times are
 * in ms. The animation clocks in ./launcher.tsx count these ms, so a debug
 * slow-down stretches the clock and not these numbers.
 */
export const MOTION = {
  /** The selection ring: the leading edge, the trailing edge. */
  glide: { lead: 110, trail: 190 },
  /** The tiles on open: each row rises over `row`, all within `total` (the panel fades in meanwhile). */
  cascade: { total: 180, row: 120, rise: 8 },
  /** Results while typing: slide; a new one comes in over `fade` ms (the mock's name), after a short delay. */
  flip: { move: 150, fade: 120, fadeDelay: 20, rise: 6, fromScale: 0.97 },
  /** The panel: opens from 96% on a spring with a quick fade, closes to 97%. */
  open: { spring: 260, zeta: 0.62, fade: 90, fromScale: 0.96, close: 110, closeScale: 0.97 },
  /** A press: in to 0.94, held 100 ms at least, a spring back. */
  press: { in: 60, hold: 100, out: 260, zeta: 0.55, scale: 0.94, ripple: 340 },
  /** Hover: the icon lifts 2 px and grows about 6%. */
  hover: { ms: 240, lift: 2, grow: 0.06 },
} as const;

/**
 * The times the launcher really uses, where they differ from MOTION. In
 * ShojiWM anything that moves inside the panel lays the whole panel out
 * again on every frame (about 15 ms here, so those frames come late). The
 * old launcher already paid that for its open (120 ms), its hover grow
 * (120 ms) and its press spring (220 ms); these keep the new motion inside
 * the same time, so it adds no late frames. The ring glide and the ripple
 * are drawn by a shader and cost nothing like that.
 */
export const BUDGET = {
  /** The open spring is stopped here: it is within a pixel of rest by then. */
  open: 150,
  /** The cascade fits inside the open. */
  cascade: { total: 150, row: 100 },
  hover: 120,
  pressOut: 220,
} as const;

export const clamp01 =(value: number) => (value <= 0 ? 0 : value >= 1 ? 1 : value);
export const outCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * A damped spring from 0 to 1 at `t` (0..1 of its duration), as the mock
 * samples it: it passes 1, swings back a little, and is exactly 1 at the end.
 */
export function springAt(t: number, zeta: number): number {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  const w = 6.5 / zeta;
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}

/**
 * How many whole px an icon of `size` px grows by `factor`: an even number,
 * so it grows the same on each side and stays on whole pixels (sharp).
 */
export function evenGrowPx(size: number, factor: number): number {
  return 2 * Math.round((size * factor) / 2);
}

/** The scale of a hovered tile icon of `size` px: about 1.06, on whole pixels. */
export const hoverIconScale = (size: number) => 1 + evenGrowPx(size, MOTION.hover.grow) / size;

// ------------------------------------------------ the gliding selection

export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One edge of the ring: it goes from `from` to `to`, starting at `start` ms. */
export interface GlideEdge {
  from: number;
  to: number;
  start: number;
  duration: number;
}

export type Glide = Record<keyof Edges, GlideEdge>;

const EDGE_NAMES = ["left", "top", "right", "bottom"] as const;

/** Where one edge is at `now` ms (the glide clock). */
export function glideEdgeAt(edge: GlideEdge, now: number, ease: (t: number) => number = outCubic): number {
  const t = clamp01((now - edge.start) / edge.duration);
  return edge.from + (edge.to - edge.from) * ease(t);
}

export function glideAt(glide: Glide, now: number, ease?: (t: number) => number): Edges {
  return {
    left: glideEdgeAt(glide.left, now, ease),
    top: glideEdgeAt(glide.top, now, ease),
    right: glideEdgeAt(glide.right, now, ease),
    bottom: glideEdgeAt(glide.bottom, now, ease),
  };
}

/** The ring sits on `target` at once. */
export function glideJump(target: Edges, now: number): Glide {
  const edge = (value: number): GlideEdge => ({ from: value, to: value, start: now, duration: 1 });
  return { left: edge(target.left), top: edge(target.top), right: edge(target.right), bottom: edge(target.bottom) };
}

/**
 * Send the ring to `target` from wherever it is at `now`. The edge in front
 * (the one moving away from the box) takes `lead` ms, the edge behind
 * `trail` ms, so the ring stretches a little while it moves. An edge that
 * already goes to its target keeps going; nothing jumps when keys repeat.
 */
export function glideTo(glide: Glide, target: Edges, now: number, lead: number, trail: number): Glide {
  const next = { ...glide };
  for (const name of EDGE_NAMES) {
    const edge = glide[name];
    const to = target[name];
    if (to === edge.to) {
      continue;
    }
    const at = glideEdgeAt(edge, now);
    const leads = name === "left" || name === "top" ? to < at : to > at;
    next[name] = { from: at, to, start: now, duration: leads ? lead : trail };
  }
  return next;
}

/** When the last edge arrives, on the glide clock. */
export function glideEnd(glide: Glide): number {
  return Math.max(...EDGE_NAMES.map((name) => glide[name].start + glide[name].duration));
}

// ------------------------------------------------ the cascade on open

/**
 * The row of each top, for the cascade: 0 for the highest top, then 1, ...
 * (section titles count as rows too).
 */
export function cascadeRows(tops: readonly number[]): Map<number, number> {
  const sorted = [...new Set(tops)].sort((a, b) => a - b);
  return new Map(sorted.map((top, row) => [top, row]));
}

/**
 * How far row `row` of `rows` is into its fade-in, `now` ms after the open
 * (0..1, before any easing). The rows start one after the other so that
 * the last one ends at `total`.
 */
export function cascadeAt(now: number, row: number, rows: number, total: number, duration: number): number {
  const stagger = rows > 1 ? Math.max(0, total - duration) / (rows - 1) : 0;
  return clamp01((now - row * stagger) / duration);
}

// ------------------------------------------------ results glide (FLIP)

/** Where an entry starts: `dx`, `dy` from its new place, or `fresh` (comes in). */
export interface FlipMove {
  dx: number;
  dy: number;
  fresh: boolean;
}

/** What makes two entries "the same" across a change: the kind and the item. */
export const flipKey = (entry: Pick<Entry, "kind" | "item">) => `${entry.kind}:${entry.item.id}`;

/**
 * FLIP: for each new entry, the offset from where the same entry was drawn
 * before (`before`, by flipKey) to its new place; an entry that was not
 * there comes in (rises and grows). `before` holds where they were on screen, so a change in
 * the middle of a glide starts from the current spot, with no jump.
 */
export function flipMoves(
  before: ReadonlyMap<string, { x: number; y: number }>,
  after: readonly { key: string; x: number; y: number }[],
): FlipMove[] {
  const used = new Set<string>();
  return after.map(({ key, x, y }) => {
    const old = before.get(key);
    if (!old || used.has(key)) {
      return { dx: 0, dy: 0, fresh: true };
    }
    used.add(key);
    return { dx: old.x - x, dy: old.y - y, fresh: false };
  });
}

/** The share of a FLIP move done at `now` (0..1, before easing). */
export const flipMoveAt = (now: number) => clamp01(now / MOTION.flip.move);
/** The share of a coming-in done at `now` (0..1, before easing). */
export const flipFadeAt = (now: number) => clamp01((now - MOTION.flip.fadeDelay) / MOTION.flip.fade);

// Where a moved or fresh entry is drawn `now` ms into the glide. They return
// plain numbers (no object per frame): the offset from its place along x or
// y, its scale, and how far in it is (0 to 1; 1 for one that moves).
export function flipShift(move: FlipMove | undefined, now: number, axis: "x" | "y", ease: (t: number) => number = outCubic): number {
  if (!move) {
    return 0;
  }
  if (move.fresh) {
    return axis === "y" ? MOTION.flip.rise * (1 - ease(flipFadeAt(now))) : 0;
  }
  return (axis === "x" ? move.dx : move.dy) * (1 - ease(flipMoveAt(now)));
}

export function flipScale(move: FlipMove | undefined, now: number, ease: (t: number) => number = outCubic): number {
  return move?.fresh ? MOTION.flip.fromScale + (1 - MOTION.flip.fromScale) * ease(flipFadeAt(now)) : 1;
}

export function flipIn(move: FlipMove | undefined, now: number, ease: (t: number) => number = outCubic): number {
  return move?.fresh ? ease(flipFadeAt(now)) : 1;
}
