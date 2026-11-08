import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BODY,
  BOTTOM_LINE_Y,
  COLUMNS,
  CONTENT_WIDTH,
  PANEL_HEIGHT,
  PANEL_WIDTH,
  PILL_HEIGHT,
  ROW_HEIGHT,
  ROW_HEIGHT_WITH_SUB,
  TILE_HEIGHT,
  TILE_WIDTH,
  bottomEntries,
  editText,
  entryAt,
  evaluateMath,
  fallbackResults,
  filterApps,
  fuzzyScore,
  keyChar,
  layoutHome,
  layoutResults,
  glowSize,
  hoverGrow,
  lightIcon,
  lightSize,
  mergeResults,
  moveSelection,
  panelRect,
  parseResults,
  repeatsDue,
  rowTextTops,
  scrollToShow,
  splitHighlights,
  stripFieldCodes,
  wantsMeaning,
  type LauncherApp,
  type LauncherItem,
  type LauncherResults,
} from "../packages/config/src/launcher-model";

const app = (name: string): LauncherApp => ({ id: `${name}.desktop`, name, icon: "", exec: name.toLowerCase() });
const APPS = Array.from({ length: 40 }, (_, index) => app(`App ${index}`));
const HOME = { recommended: APPS.slice(0, 16), pinned: APPS.slice(16) };
const item = (title: string, sub = ""): LauncherItem => ({ id: title, title, sub, icon: "", action: { kind: "open", value: title } });

// ---------------------------------------------------------------- geometry

test("the panel is 88% of the mock: 8 tiles make about 900 px of content", () => {
  assert.equal(CONTENT_WIDTH, 900);
  assert.equal(TILE_WIDTH * COLUMNS + 4 * (COLUMNS - 1), CONTENT_WIDTH);
  assert.ok(Math.abs(PANEL_WIDTH - 1082 * 0.88) < 3, `width ${PANEL_WIDTH}`);
  assert.ok(Math.abs(PANEL_HEIGHT - 800 * 0.88) < 6, `height ${PANEL_HEIGHT}`);
});

test("the panel is centred, its middle at 47% of the screen height", () => {
  const rect = panelRect({ x: 0, y: 0, width: 2560, height: 1440 });
  assert.equal(rect.x + rect.width / 2, 1280);
  assert.ok(Math.abs(rect.y + rect.height / 2 - 1440 * 0.47) <= 1);
  const right = panelRect({ x: 2560, y: 0, width: 1920, height: 1080 });
  assert.ok(right.x > 2560 && right.x + right.width < 2560 + 1920);
});

test("only the Shut down light is as big as the avatar; icons are about half", () => {
  assert.equal(lightSize(4), 30);
  assert.ok(lightSize(0) < lightSize(4));
  for (let index = 0; index < 5; index++) {
    assert.equal((lightSize(index) - lightIcon(index)) % 2, 0, "the icon sits on whole pixels");
    assert.ok(Math.abs(lightIcon(index) / lightSize(index) - 0.5) < 0.06);
  }
});

test("a hovered light and the avatar grow to whole, even pixel sizes (they stay sharp)", () => {
  for (const size of [lightSize(0), lightSize(4), 26, 30, 34]) {
    const grown = size * (1 + hoverGrow(size));
    assert.ok(Math.abs(grown - Math.round(grown)) < 1e-9, `${size} grows to ${grown}`);
    assert.equal((Math.round(grown) - size) % 2, 0, "it grows the same on both sides");
    assert.ok(Math.abs(hoverGrow(size) - 0.2) < 0.04, `about 20%, got ${hoverGrow(size)}`);
    const glow = glowSize(size) * (1 + hoverGrow(size));
    assert.ok(Math.abs(glow - Math.round(grown) - 6) < 1e-9, `the grown glow is 3 px wider on each side, got ${glow}`);
  }
});

test("a row's title and subtitle are one block, centred", () => {
  const pill = rowTextTops(PILL_HEIGHT, true, true);
  const bottomGap = PILL_HEIGHT - (pill.sub + 16);
  assert.ok(Math.abs(pill.title - bottomGap) <= 1, `top ${pill.title}, bottom ${bottomGap}`);
  const single = rowTextTops(ROW_HEIGHT, false, false);
  assert.ok(single.title > 0 && single.title < ROW_HEIGHT / 2);
});

// ---------------------------------------------------------------- layout

test("the default view: 2 rows of Recommended, 3 rows of Apps, in the fixed body", () => {
  const layout = layoutHome(HOME);
  assert.deepEqual(layout.headers.map((header) => header.text), ["Recommended", "Apps"]);
  assert.equal(layout.entries.length, 40);
  const lines = new Set(layout.entries.map((entry) => entry.y));
  assert.equal(lines.size, 5);
  const last = layout.entries[39];
  assert.ok(last.y + last.height <= BODY.height, "the grid fits the body");
  assert.equal(layout.entries[8].x, layout.entries[0].x, "column 1 again on row 2");
});

test("results: top pill, apps grid, rows, web; heights from the mock", () => {
  const layout = layoutResults([
    { kind: "top", items: [item("Dolphin", "File Manager")] },
    { kind: "apps", items: [item("A"), item("B")] },
    { kind: "files", items: [item("notes.md", "~/Documents"), item("x")] },
    { kind: "web", items: [item("Search the web")] },
  ]);
  assert.deepEqual(layout.headers.map((header) => header.text), ["Apps", "Files", "Web"]);
  const [pill, a, b, file, plain, web] = layout.entries;
  assert.equal(pill.kind, "pill");
  assert.equal(pill.height, PILL_HEIGHT);
  assert.equal(a.kind, "tile");
  assert.equal(b.x - a.x, TILE_WIDTH + 4);
  assert.equal(file.height, ROW_HEIGHT_WITH_SUB);
  assert.equal(plain.height, ROW_HEIGHT);
  assert.equal(plain.y, file.y + file.height + 2);
  assert.equal(web.kind, "row");
  assert.ok(a.y >= pill.y + pill.height);
  assert.ok(file.y >= a.y + TILE_HEIGHT);
});

test("a pending meaning search shows its title and a note before Web", () => {
  const layout = layoutResults([{ kind: "web", items: [item("web")] }], true);
  assert.deepEqual(layout.headers.map((header) => header.text), ["By meaning", "Web"]);
  assert.equal(layout.notes[0].text, "searching inside your files...");
  assert.equal(layoutResults([]).notes[0].text, "Nothing found");
});

test("hit testing finds the entry under a point", () => {
  const layout = layoutHome(HOME);
  const tile = layout.entries[9];
  assert.equal(entryAt(layout.entries, tile.x + 5, tile.y + 5), 9);
  assert.equal(entryAt(layout.entries, 0, 0), -1);
});

test("scrolling keeps the selected entry inside the body", () => {
  const rows = Array.from({ length: 6 }, (_, index) => item(`f${index}`, "sub"));
  const layout = layoutResults([
    { kind: "files", items: rows },
    { kind: "settings", items: rows },
    { kind: "meaning", items: rows },
  ]);
  assert.ok(layout.height > BODY.height);
  const last = layout.entries[layout.entries.length - 1];
  const scroll = scrollToShow(last, 0, layout.height);
  assert.ok(last.y + last.height - scroll <= BODY.height);
  assert.equal(scrollToShow(layout.entries[0], scroll, layout.height), 0);
});

// ---------------------------------------------------------------- selection

const NAV = [...layoutHome(HOME).entries, ...bottomEntries()];
const path = (start: number, keys: ("Left" | "Right" | "Up" | "Down")[]) => {
  const steps = [start];
  for (const key of keys) {
    steps.push(moveSelection(NAV, steps[steps.length - 1], key));
  }
  return steps;
};

test("Right wraps to the next row, and into Apps", () => {
  assert.deepEqual(path(0, Array(9).fill("Right")), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(moveSelection(NAV, 15, "Right"), 16, "Recommended's last tile to Apps' first");
  assert.equal(moveSelection(NAV, 8, "Left"), 7, "back to the end of the row above");
});

test("Down keeps the column, crosses into Apps, then reaches the bottom row", () => {
  const steps = path(0, Array(6).fill("Down"));
  assert.deepEqual(steps.slice(0, 5), [0, 8, 16, 24, 32]);
  assert.equal(NAV[steps[5]].y, BOTTOM_LINE_Y, "the 5th Down lands on the bottom row");
  assert.equal(steps[5], 40, "column 1 lands on the account");
  assert.equal(steps[6], 40, "nothing below the bottom row");
});

test("Up from the first Apps row goes back to Recommended; Up from the bottom row returns to the grid", () => {
  assert.equal(moveSelection(NAV, 16, "Up"), 8);
  assert.equal(moveSelection(NAV, 19, "Up"), 11);
  const fromShutDown = moveSelection(NAV, 45, "Up");
  assert.ok(fromShutDown >= 32 && fromShutDown < 40, "to the last grid row");
  assert.equal(fromShutDown, 39, "Shut down is under the last column");
});

test("Left and Right move along the bottom row", () => {
  assert.equal(moveSelection(NAV, 40, "Right"), 41);
  assert.equal(moveSelection(NAV, 45, "Right"), 45);
  assert.equal(moveSelection(NAV, 41, "Left"), 40);
});

test("in results, Up and Down go through every row of every section", () => {
  const layout = layoutResults([
    { kind: "top", items: [item("top")] },
    { kind: "files", items: [item("a", "s"), item("b", "s")] },
    { kind: "web", items: [item("web")] },
  ]);
  const nav = [...layout.entries, ...bottomEntries()];
  const steps = [0];
  for (let index = 0; index < 4; index++) {
    steps.push(moveSelection(nav, steps[steps.length - 1], "Down"));
  }
  assert.deepEqual(steps.slice(0, 4), [0, 1, 2, 3]);
  assert.equal(nav[steps[4]].y, BOTTOM_LINE_Y);
});

// ---------------------------------------------------------------- text

test("keys type characters; Shift follows the US layout", () => {
  assert.equal(keyChar("a"), "a");
  assert.equal(keyChar("a", { shift: true }), "A");
  assert.equal(keyChar("1", { shift: true }), "!");
  assert.equal(keyChar("space"), " ");
  assert.equal(keyChar("KP_Multiply"), "*");
  assert.equal(keyChar("Escape"), null);
  assert.equal(keyChar("a", { ctrl: true }), null);
});

test("editing: insert at the caret, Backspace, Ctrl+Backspace, Delete, Home, End", () => {
  let state = { text: "", caret: 0 };
  for (const key of ["h", "i", "space", "y", "o", "u"]) {
    state = editText(state, key)!;
  }
  assert.deepEqual(state, { text: "hi you", caret: 6 });
  assert.deepEqual(editText(state, "BackSpace"), { text: "hi yo", caret: 5 });
  assert.deepEqual(editText(state, "BackSpace", { ctrl: true }), { text: "hi ", caret: 3 });
  const home = editText(state, "Home")!;
  assert.equal(home.caret, 0);
  assert.deepEqual(editText(home, "Delete"), { text: "i you", caret: 0 });
  assert.deepEqual(editText(editText(home, "x")!, "End"), { text: "xhi you", caret: 7 });
  assert.equal(editText(state, "Down"), null);
});

// ---------------------------------------------------------------- search

test("fuzzy search ranks prefix, then substring, then letters in order", () => {
  assert.equal(fuzzyScore("Dolphin", "dol"), 3);
  assert.equal(fuzzyScore("KDE Dolphin", "dol"), 2);
  assert.equal(fuzzyScore("Discord Online", "dol"), 1);
  assert.equal(fuzzyScore("Chrome", "dol"), -1);
  const apps = ["Discord Online", "Dolphin", "KDE Dolphin"].map(app);
  assert.deepEqual(filterApps(apps, "dol").map((entry) => entry.name), ["Dolphin", "KDE Dolphin", "Discord Online"]);
});

test("maths: + - * / and brackets, never code", () => {
  assert.equal(evaluateMath("19*4+2"), 78);
  assert.equal(evaluateMath("(1+2)*3"), 9);
  assert.equal(evaluateMath("0.1+0.2"), 0.3);
  assert.equal(evaluateMath("-2*3"), -6);
  assert.equal(evaluateMath("12"), null);
  assert.equal(evaluateMath("2+"), null);
  assert.equal(evaluateMath("alert(1)"), null);
  assert.equal(evaluateMath("1/0"), null);
});

test("the built-in results: math, the best app on top, more apps, web", () => {
  const apps = ["Dolphin", "Dolby", "Chrome"].map(app);
  const results = fallbackResults(apps, "dol", 4);
  assert.equal(results.id, 4);
  assert.deepEqual(results.sections.map((section) => section.kind), ["top", "apps", "web"]);
  assert.equal(results.sections[0].items[0].title, "Dolphin");
  assert.deepEqual(fallbackResults(apps, "2*3").sections.map((section) => section.kind), ["math", "web"]);
  assert.ok(wantsMeaning("recording where we talked"));
  assert.ok(!wantsMeaning("dol"));
});

// ---------------------------------------------------------------- protocol

const results = (id: number, kinds: string[]): LauncherResults => ({
  id,
  q: "q",
  sections: kinds.map((kind) => ({ kind: kind as never, items: [item(kind)] })),
});

test("a reply for an older query is dropped", () => {
  const current = results(5, ["top"]);
  assert.equal(mergeResults(current, results(4, ["files"]), 5), current);
  assert.deepEqual(mergeResults(current, results(5, ["files"]), 5)?.sections.map((s) => s.kind), ["top", "files"]);
});

test("a newer query replaces; a second reply with the same id adds meaning before web", () => {
  const first = mergeResults(results(3, ["top"]), results(4, ["top", "files", "web"]), 4)!;
  assert.deepEqual(first.sections.map((section) => section.kind), ["top", "files", "web"]);
  const merged = mergeResults(first, results(4, ["meaning"]), 4)!;
  assert.deepEqual(merged.sections.map((section) => section.kind), ["top", "files", "meaning", "web"]);
  const again = mergeResults(merged, { id: 4, q: "q", sections: [{ kind: "meaning", items: [item("m2")] }] }, 4)!;
  assert.equal(again.sections.find((section) => section.kind === "meaning")?.items[0].title, "m2");
});

test("malformed results are refused or cleaned", () => {
  assert.equal(parseResults(null), null);
  assert.equal(parseResults({ q: "x" }), null);
  const parsed = parseResults({ id: 1, sections: [{ kind: "files", items: [{ title: "ok", action: { kind: "open", value: "/x" } }, { nope: 1 }] }, 7] });
  assert.equal(parsed?.sections.length, 1);
  assert.equal(parsed?.sections[0].items.length, 1);
});

test("exec lines lose their field codes", () => {
  assert.equal(stripFieldCodes("/usr/bin/google-chrome-stable %U"), "/usr/bin/google-chrome-stable");
  assert.equal(stripFieldCodes("code --new-window %F"), "code --new-window");
  assert.equal(stripFieldCodes("printf 100%%"), "printf 100%");
});

test("highlights split a subtitle into plain and marked parts", () => {
  assert.deepEqual(splitHighlights("so for the pricing we", [[11, 18]]), [
    { text: "so for the ", mark: false },
    { text: "pricing", mark: true },
    { text: " we", mark: false },
  ]);
  assert.deepEqual(splitHighlights("abc", [[5, 9]]), [{ text: "abc", mark: false }]);
  assert.equal(splitHighlights("a b c d e", [[0, 1], [2, 3], [4, 5]]).filter((part) => part.mark).length, 2);
});

// ---------------------------------------------------------------- key repeat

test("a held key: nothing during the delay, then the rate, speeding up to 2x", () => {
  assert.equal(repeatsDue(249, 250, 30), 0);
  assert.equal(repeatsDue(250, 250, 30), 1);
  // 1 s after the delay: 1.5 s worth at the base rate.
  assert.equal(repeatsDue(1250, 250, 30), 1 + 45);
  // From then on, twice the rate: 60 per second.
  assert.equal(repeatsDue(2250, 250, 30) - repeatsDue(1250, 250, 30), 60);
});
