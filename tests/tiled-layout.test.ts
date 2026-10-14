import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTree,
  canInsert,
  chooseLeafToSplit,
  cycleWidthShare,
  flip,
  insert,
  layout,
  leafIds,
  neighbour,
  remove,
  resize,
  siblingLeaf,
  swap,
  TILED_RESIZE_STEP,
  type TileRect,
  type TileTree,
} from "../packages/config/src/tiled-layout";

const GAP = 12;
const WIDE: TileRect = { x: 0, y: 0, width: 2560, height: 1440 };
const PORTRAIT: TileRect = { x: 0, y: 0, width: 1440, height: 2560 };
const SMALL: TileRect = { x: 0, y: 0, width: 1366, height: 768 };

/** Open the windows one by one; each new window takes the focus. */
function open(area: TileRect, count: number): TileTree {
  let tree: TileTree = null;
  for (let i = 1; i <= count; i++) {
    const focusedId = i > 1 ? String(i - 1) : null;
    tree = insert(tree, String(i), { area, gap: GAP, focusedId });
  }
  return tree;
}

/** The rects as plain objects, rounded to 0.01 px. */
function rects(tree: TileTree, area: TileRect = WIDE) {
  const result: Record<string, number[]> = {};
  for (const [id, rect] of layout(tree, area, GAP)) {
    result[id] = [rect.x, rect.y, rect.width, rect.height].map(
      (value) => Math.round(value * 100) / 100,
    );
  }
  return result;
}

test("1 window fills the screen", () => {
  assert.deepEqual(rects(open(WIDE, 1)), { 1: [0, 0, 2560, 1440] });
});

test("2 windows sit side by side", () => {
  assert.deepEqual(rects(open(WIDE, 2)), {
    1: [0, 0, 1274, 1440],
    2: [1286, 0, 1274, 1440],
  });
});

test("3 windows: left full height, right split top and bottom", () => {
  assert.deepEqual(rects(open(WIDE, 3)), {
    1: [0, 0, 1274, 1440],
    2: [1286, 0, 1274, 714],
    3: [1286, 726, 1274, 714],
  });
});

test("4 windows: 2 x 2, the 4th below the 1st", () => {
  assert.deepEqual(rects(open(WIDE, 4)), {
    1: [0, 0, 1274, 714],
    4: [0, 726, 1274, 714],
    2: [1286, 0, 1274, 714],
    3: [1286, 726, 1274, 714],
  });
});

test("buildTree gives the same tree as opening the windows in order", () => {
  assert.deepEqual(buildTree(["1", "2", "3", "4"], WIDE, GAP), open(WIDE, 4));
});

test("a 5th window does not fit on 2560 x 1440", () => {
  const context = { area: WIDE, gap: GAP, focusedId: "4" };
  assert.equal(canInsert(open(WIDE, 3), context), true);
  assert.equal(canInsert(open(WIDE, 4), context), false);
  assert.equal(canInsert(null, context), true);
});

test("a portrait screen gives rows", () => {
  assert.deepEqual(rects(open(PORTRAIT, 2), PORTRAIT), {
    1: [0, 0, 1440, 1274],
    2: [0, 1286, 1440, 1274],
  });
});

test("1366 x 768 is full at 2 windows (min height)", () => {
  const context = { area: SMALL, gap: GAP, focusedId: "1" };
  assert.equal(canInsert(open(SMALL, 1), context), true);
  // The 3rd window would be 677 x 378: under 400 px high.
  const big = { minWidth: 600, minHeight: 400, maxWindows: 100 };
  assert.equal(canInsert(open(SMALL, 2), { ...context, focusedId: "2" }, big), false);
});

test("remove gives back the layout from before", () => {
  assert.deepEqual(remove(open(WIDE, 4), "4"), open(WIDE, 3));
  assert.deepEqual(remove(open(WIDE, 3), "3"), open(WIDE, 2));
  assert.deepEqual(remove(open(WIDE, 1), "1"), null);
  // The sibling takes the whole space of the split.
  assert.deepEqual(rects(remove(open(WIDE, 3), "2")), {
    1: [0, 0, 1274, 1440],
    3: [1286, 0, 1274, 1440],
  });
  assert.equal(siblingLeaf(open(WIDE, 3), "2"), "3");
  assert.equal(siblingLeaf(open(WIDE, 3), "1"), "2");
  assert.equal(siblingLeaf(open(WIDE, 1), "1"), null);
});

test("rule 1: on a tie the most recently focused window is split", () => {
  const tree = open(WIDE, 2);
  const context = { area: WIDE, gap: GAP, focusedId: "gone" };
  assert.equal(chooseLeafToSplit(tree, { ...context, recentFocusOrder: ["1", "2"] }), "1");
  assert.equal(chooseLeafToSplit(tree, { ...context, recentFocusOrder: ["2", "1"] }), "2");
  // The biggest window wins over the focused one.
  assert.equal(chooseLeafToSplit(open(WIDE, 3), { area: WIDE, gap: GAP, focusedId: "3" }), "1");
});

test("flip turns side by side into top and bottom", () => {
  assert.deepEqual(rects(flip(open(WIDE, 2), "2")), {
    1: [0, 0, 2560, 714],
    2: [0, 726, 2560, 714],
  });
  // A single window has no split to flip.
  assert.deepEqual(flip(open(WIDE, 1), "1"), open(WIDE, 1));
});

test("resize moves the divider by 5% of the split", () => {
  const tree = open(WIDE, 2);
  const wider = resize(tree, "1", TILED_RESIZE_STEP, WIDE, GAP);
  assert.equal(rects(wider)[1][2], Math.round(2548 * 0.55 * 100) / 100);
  // The second window grows when the divider moves to the left.
  const second = resize(tree, "2", TILED_RESIZE_STEP, WIDE, GAP);
  assert.equal(rects(second)[2][2], Math.round(2548 * 0.55 * 100) / 100);
});

test("resize stops at the min size and at the min ratio", () => {
  let tree = open(WIDE, 2);
  for (let i = 0; i < 20; i++) {
    tree = resize(tree, "1", -TILED_RESIZE_STEP, WIDE, GAP);
  }
  assert.equal(rects(tree)[1][2], 600);

  // With tiny min sizes the ratio stops at 0.1.
  const tiny = { minWidth: 10, minHeight: 10, maxWindows: 4 };
  let small = open(WIDE, 2);
  for (let i = 0; i < 20; i++) {
    small = resize(small, "1", -TILED_RESIZE_STEP, WIDE, GAP, tiny);
  }
  assert.equal(rects(small)[1][2], Math.round(2548 * 0.1 * 100) / 100);

  // The right side holds a split: it keeps at least 600 px too.
  let three = open(WIDE, 3);
  for (let i = 0; i < 20; i++) {
    three = resize(three, "1", TILED_RESIZE_STEP, WIDE, GAP);
  }
  assert.equal(rects(three)[2][2], 600);

  // A single window has no divider: the same tree comes back.
  const one = open(WIDE, 1);
  assert.equal(resize(one, "1", TILED_RESIZE_STEP, WIDE, GAP), one);
});

test("neighbour finds the window in a direction by geometry", () => {
  const four = layout(open(WIDE, 4), WIDE, GAP);
  assert.equal(neighbour(four, "1", "right"), "2");
  assert.equal(neighbour(four, "1", "down"), "4");
  assert.equal(neighbour(four, "1", "left"), null);
  assert.equal(neighbour(four, "1", "up"), null);
  assert.equal(neighbour(four, "4", "right"), "3");
  assert.equal(neighbour(four, "3", "up"), "2");
  assert.equal(neighbour(four, "3", "left"), "4");

  // Two windows at the same distance: the one focused last wins.
  const three = layout(open(WIDE, 3), WIDE, GAP);
  assert.equal(neighbour(three, "1", "right"), "2");
  assert.equal(neighbour(three, "1", "right", ["3", "2"]), "3");
  assert.equal(neighbour(three, "3", "left"), "1");
});

test("swap trades the places of two windows", () => {
  const swapped = swap(open(WIDE, 4), "1", "3");
  assert.deepEqual(rects(swapped)[3], [0, 0, 1274, 714]);
  assert.deepEqual(rects(swapped)[1], [1286, 726, 1274, 714]);
  assert.deepEqual(leafIds(swapped), ["3", "4", "2", "1"]);
});

test("cycleWidthShare: Super+R steps the stack through 1/3, 1/2, 2/3", () => {
  // 1 on the left, 2 and 3 stacked on the right. Each side has 1/2.
  const three = open(WIDE, 3);
  const width = (tree: TileTree, id: string) => rects(tree)[Number(id)][2];
  const available = WIDE.width - GAP;
  const near = (got: number, share: number) =>
    assert.ok(Math.abs(got - available * share) < 1, `${got} vs ${share}`);

  const up1 = cycleWidthShare(three, "2", 1, WIDE, GAP);
  near(width(up1, "2"), 2 / 3);
  near(width(up1, "3"), 2 / 3);
  near(width(up1, "1"), 1 / 3);

  // From 2/3 it wraps to 1/3. Window 1 stays on the page with the rest.
  const up2 = cycleWidthShare(up1, "2", 1, WIDE, GAP);
  near(width(up2, "2"), 1 / 3);
  near(width(up2, "1"), 2 / 3);

  const up3 = cycleWidthShare(up2, "3", 1, WIDE, GAP);
  near(width(up3, "2"), 1 / 2);
  near(width(up3, "1"), 1 / 2);

  // Super+Ctrl+R goes the other way.
  const down = cycleWidthShare(three, "1", -1, WIDE, GAP);
  near(width(down, "1"), 1 / 3);
  near(width(down, "2"), 2 / 3);

  // Every window stays inside the screen.
  for (const tree of [up1, up2, up3, down]) {
    for (const [x, , w] of Object.values(rects(tree))) {
      assert.ok(x >= 0 && x + w <= WIDE.width + 0.5);
    }
  }
});

test("cycleWidthShare skips shares under the min size", () => {
  // 1366 wide: 1/3 is 451 px, under 600, so no share fits.
  const two = open(SMALL, 2);
  assert.equal(cycleWidthShare(two, "1", 1, SMALL, GAP), two);
  // Portrait: no side-by-side split at all.
  const rows = open(PORTRAIT, 2);
  assert.equal(cycleWidthShare(rows, "1", 1, PORTRAIT, GAP), rows);
});
