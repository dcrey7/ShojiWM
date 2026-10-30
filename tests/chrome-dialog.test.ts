import assert from "node:assert/strict";
import { test } from "node:test";
import type { WaylandWindow } from "../packages/shoji_wm/src/types.ts";
import { isChromeDialog } from "../packages/config/src/window-manager.ts";

/** Just the fields `isChromeDialog` reads. */
function chromeWindow(role: string | undefined, title = "Google Chrome", appId = "Google-chrome") {
  const value = <T>(v: T) => ({ peek: () => v });
  return {
    appId: value(appId),
    title: value(title),
    x11Role: value(role),
  } as unknown as WaylandWindow;
}

test("the profile picker floats: Chrome sets no role on it", () => {
  assert.equal(isChromeDialog(chromeWindow("")), true);
});

test("an OAuth popup floats", () => {
  assert.equal(isChromeDialog(chromeWindow("pop-up", "Sign in - Google Accounts")), true);
});

test("a browser window and DevTools tile", () => {
  assert.equal(isChromeDialog(chromeWindow("browser", "New Tab - Google Chrome")), false);
  assert.equal(isChromeDialog(chromeWindow("pop-up", "DevTools - example.com")), false);
});

test("an older ShojiWM sends no role: nothing changes", () => {
  assert.equal(isChromeDialog(chromeWindow(undefined)), false);
});

test("other X11 apps keep their rules", () => {
  assert.equal(isChromeDialog(chromeWindow("", "GIMP", "Gimp")), false);
});
