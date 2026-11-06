import assert from "node:assert/strict";
import { test } from "node:test";
import { opensOnNewPage } from "../packages/config/src/window-manager.ts";

test("an empty page always takes the new window", () => {
  assert.equal(opensOnNewPage({ hasRoom: true, tileCount: 0, minimizedTileCount: 0, newWindowMaximized: true }), false);
});

test("a page with room takes a normal window", () => {
  assert.equal(opensOnNewPage({ hasRoom: true, tileCount: 1, minimizedTileCount: 0, newWindowMaximized: false }), false);
});

test("a full or maximized page sends the new window to a new workspace", () => {
  // A lone maximized Konsole: canTakeNewTile says no room.
  assert.equal(opensOnNewPage({ hasRoom: false, tileCount: 1, minimizedTileCount: 0, newWindowMaximized: false }), true);
});

test("a window that opens maximized gets its own page", () => {
  // Dolphin remembers it was maximized and opens next to Konsole.
  assert.equal(opensOnNewPage({ hasRoom: true, tileCount: 1, minimizedTileCount: 0, newWindowMaximized: true }), true);
});

test("a minimized tile still holds its page against a maximized window", () => {
  // 6 Nov: Konsole was the page's only tile and sat minimized. Dolphin
  // opened maximized, saw no tiles, and joined the page. Konsole came back
  // half size behind a full-screen Dolphin: two tiles, no tiling.
  assert.equal(
    opensOnNewPage({
      hasRoom: true,
      tileCount: 0,
      minimizedTileCount: 1,
      newWindowMaximized: true,
    }),
    true,
  );
});

test("a page with only minimized tiles takes a normal window", () => {
  assert.equal(
    opensOnNewPage({
      hasRoom: true,
      tileCount: 0,
      minimizedTileCount: 1,
      newWindowMaximized: false,
    }),
    false,
  );
});
