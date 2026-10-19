/**
 * The tiled layout: every window of a workspace fits on one screen.
 *
 * The layout is a binary split tree. A leaf is one window. A split cuts its
 * area in two parts: "row" puts the parts side by side, "column" puts them
 * top and bottom. `ratio` is the share of the first part (left or top).
 *
 *   split row 0.5                 ┌─────┬─────┐
 *   ├── leaf 1                    │     │  2  │
 *   └── split column 0.5          │  1  ├─────┤
 *       ├── leaf 2                │     │  3  │
 *       └── leaf 3                └─────┴─────┘
 *
 * Every function here is pure: it returns a new tree and never changes the
 * tree it gets. It knows nothing about windows, only about ids and rects.
 * The rules come from the spec: shojiwm-setup/docs/wiki/tiled-layout-spec.md.
 */

/** No window may get narrower than this when a new window comes in. */
export const TILED_MIN_WIDTH = 600;
/** No window may get lower than this when a new window comes in. */
export const TILED_MIN_HEIGHT = 400;
/** A tiled workspace holds at most this many windows. */
export const TILED_MAX_WINDOWS = 4;
/** Super+Minus / Super+Equal move a divider by this share of the split. */
export const TILED_RESIZE_STEP = 0.05;
/** A split never gives one side less than this share. */
export const TILED_MIN_RATIO = 0.1;
/** Two windows have the "same" area when they differ by 1% or less. */
const TIE_TOLERANCE = 0.01;
/** Rects closer than this (logical px) count as touching. */
const EDGE_TOLERANCE = 1;
/** A rect smaller than the minimum by this much or less still fits. */
const SIZE_TOLERANCE = 0.5;

export type SplitDirection = "row" | "column";
export type TileDirection = "left" | "right" | "up" | "down";

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileLeaf {
  kind: "leaf";
  id: string;
}

export interface TileSplit {
  kind: "split";
  direction: SplitDirection;
  ratio: number;
  first: TileNode;
  second: TileNode;
}

export type TileNode = TileLeaf | TileSplit;
/** An empty workspace has no tree. */
export type TileTree = TileNode | null;

export interface TileLimits {
  minWidth: number;
  minHeight: number;
  maxWindows: number;
}

export const DEFAULT_TILE_LIMITS: TileLimits = {
  minWidth: TILED_MIN_WIDTH,
  minHeight: TILED_MIN_HEIGHT,
  maxWindows: TILED_MAX_WINDOWS,
};

/** What `insert` needs to know to pick the window to split. */
export interface InsertContext {
  /** The rect the whole tree fills. */
  area: TileRect;
  /** The space between two windows. */
  gap: number;
  /** The focused window, if it is in the tree. */
  focusedId?: string | null;
  /** Window ids, the most recently focused first. */
  recentFocusOrder?: readonly string[];
}

/** The window ids of the tree, left to right (first child first). */
export function leafIds(tree: TileTree): string[] {
  if (!tree) {
    return [];
  }
  if (tree.kind === "leaf") {
    return [tree.id];
  }
  return [...leafIds(tree.first), ...leafIds(tree.second)];
}

export function hasLeaf(tree: TileTree, id: string): boolean {
  return leafIds(tree).includes(id);
}

/** Cut `rect` in two along `direction`, with `gap` between the parts. */
function splitRect(
  rect: TileRect,
  direction: SplitDirection,
  ratio: number,
  gap: number,
): [TileRect, TileRect] {
  if (direction === "row") {
    const available = Math.max(0, rect.width - gap);
    const firstWidth = available * ratio;
    return [
      { x: rect.x, y: rect.y, width: firstWidth, height: rect.height },
      {
        x: rect.x + firstWidth + gap,
        y: rect.y,
        width: available - firstWidth,
        height: rect.height,
      },
    ];
  }
  const available = Math.max(0, rect.height - gap);
  const firstHeight = available * ratio;
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: firstHeight },
    {
      x: rect.x,
      y: rect.y + firstHeight + gap,
      width: rect.width,
      height: available - firstHeight,
    },
  ];
}

/** The rect of every window in the tree, by id. */
export function layout(
  tree: TileTree,
  area: TileRect,
  gap: number,
): Map<string, TileRect> {
  const rects = new Map<string, TileRect>();
  const visit = (node: TileNode, rect: TileRect) => {
    if (node.kind === "leaf") {
      rects.set(node.id, rect);
      return;
    }
    const [first, second] = splitRect(rect, node.direction, node.ratio, gap);
    visit(node.first, first);
    visit(node.second, second);
  };
  if (tree) {
    visit(tree, area);
  }
  return rects;
}

/**
 * Rule 1: the window to split. The biggest window wins. On a tie (areas
 * within 1%), the focused window wins. When the focused window is not one
 * of the biggest, the most recently focused of them wins. Then tree order.
 */
export function chooseLeafToSplit(
  tree: TileTree,
  context: InsertContext,
): string | null {
  const rects = layout(tree, context.area, context.gap);
  let biggest = 0;
  for (const rect of rects.values()) {
    biggest = Math.max(biggest, rect.width * rect.height);
  }
  const ties = [...rects.entries()]
    .filter(([, rect]) => rect.width * rect.height >= biggest * (1 - TIE_TOLERANCE))
    .map(([id]) => id);
  if (ties.length === 0) {
    return null;
  }
  if (context.focusedId && ties.includes(context.focusedId)) {
    return context.focusedId;
  }
  return mostRecent(ties, context.recentFocusOrder ?? []) ?? ties[0];
}

/** The id of `ids` that comes first in `recentFocusOrder`, or null. */
function mostRecent(
  ids: readonly string[],
  recentFocusOrder: readonly string[],
): string | null {
  for (const id of recentFocusOrder) {
    if (ids.includes(id)) {
      return id;
    }
  }
  return null;
}

/** Replace the leaf `id` with `next`. */
function replaceLeaf(node: TileNode, id: string, next: TileNode): TileNode {
  if (node.kind === "leaf") {
    return node.id === id ? next : node;
  }
  return {
    ...node,
    first: replaceLeaf(node.first, id, next),
    second: replaceLeaf(node.second, id, next),
  };
}

/**
 * Add the window `newId` (rules 1 and 2). Rule 2: cut the chosen window
 * along its longer side. Wider than tall (or square): side by side, the new
 * window on the right. Taller than wide: top and bottom, the new window
 * below. `insert` does not check the limits; use `canInsert` for that.
 */
export function insert(
  tree: TileTree,
  newId: string,
  context: InsertContext,
): TileTree {
  const newLeaf: TileLeaf = { kind: "leaf", id: newId };
  if (!tree) {
    return newLeaf;
  }
  const targetId = chooseLeafToSplit(tree, context);
  const rect = targetId
    ? layout(tree, context.area, context.gap).get(targetId)
    : undefined;
  if (!targetId || !rect) {
    return tree;
  }
  const split: TileSplit = {
    kind: "split",
    direction: rect.width >= rect.height ? "row" : "column",
    ratio: 0.5,
    first: { kind: "leaf", id: targetId },
    second: newLeaf,
  };
  return replaceLeaf(tree, targetId, split);
}

/** True when every window of `tree` is at least the minimum size. */
function fitsMinSize(
  tree: TileTree,
  area: TileRect,
  gap: number,
  limits: TileLimits,
): boolean {
  for (const rect of layout(tree, area, gap).values()) {
    if (
      rect.width < limits.minWidth - SIZE_TOLERANCE ||
      rect.height < limits.minHeight - SIZE_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Rule 3: a new window fits when the workspace holds fewer than
 * `maxWindows` windows and no window gets under the minimum size.
 */
export function canInsert(
  tree: TileTree,
  context: InsertContext,
  limits: TileLimits = DEFAULT_TILE_LIMITS,
): boolean {
  const ids = leafIds(tree);
  if (ids.length >= limits.maxWindows) {
    return false;
  }
  if (!tree) {
    return true;
  }
  // An id that is surely not in the tree stands for the new window.
  const probeId = `probe:${ids.join(",")}`;
  const next = insert(tree, probeId, context);
  return fitsMinSize(next, context.area, context.gap, limits);
}

/** Take the window `id` out. Its sibling takes the whole space of the split. */
export function remove(tree: TileTree, id: string): TileTree {
  if (!tree) {
    return null;
  }
  if (tree.kind === "leaf") {
    return tree.id === id ? null : tree;
  }
  if (tree.first.kind === "leaf" && tree.first.id === id) {
    return tree.second;
  }
  if (tree.second.kind === "leaf" && tree.second.id === id) {
    return tree.first;
  }
  return {
    ...tree,
    first: remove(tree.first, id) ?? tree.first,
    second: remove(tree.second, id) ?? tree.second,
  };
}

/**
 * A window leaves: its sibling takes back the space, and every other split
 * keeps its ratio. So opening and then closing a window gives back the
 * layout from before. Only inside the sibling, a split that now cuts along
 * the shorter side is turned (two wide strips become two columns).
 */
export function removeAndSettle(
  tree: TileTree,
  id: string,
  area: TileRect,
  gap: number,
): TileTree {
  if (!tree || !hasLeaf(tree, id)) {
    return tree;
  }
  if (tree.kind === "leaf") {
    return null;
  }
  const visit = (node: TileNode, rect: TileRect): TileNode => {
    if (node.kind === "leaf") {
      return node;
    }
    const [firstRect, secondRect] = splitRect(rect, node.direction, node.ratio, gap);
    if (node.first.kind === "leaf" && node.first.id === id) {
      return settle(node.second, rect, gap);
    }
    if (node.second.kind === "leaf" && node.second.id === id) {
      return settle(node.first, rect, gap);
    }
    return hasLeaf(node.first, id)
      ? { ...node, first: visit(node.first, firstRect) }
      : { ...node, second: visit(node.second, secondRect) };
  };
  return visit(tree, area);
}

/** Turn every split of `node` that cuts its rect along the shorter side. */
function settle(node: TileNode, rect: TileRect, gap: number): TileNode {
  if (node.kind === "leaf") {
    return node;
  }
  const direction: SplitDirection = rect.width >= rect.height ? "row" : "column";
  const [firstRect, secondRect] = splitRect(rect, direction, node.ratio, gap);
  return {
    ...node,
    direction,
    first: settle(node.first, firstRect, gap),
    second: settle(node.second, secondRect, gap),
  };
}

/**
 * The window that takes the space when `id` goes away: the first window of
 * its sibling. Null when `id` is alone or not in the tree.
 */
export function siblingLeaf(tree: TileTree, id: string): string | null {
  if (!tree || tree.kind === "leaf") {
    return null;
  }
  if (tree.first.kind === "leaf" && tree.first.id === id) {
    return leafIds(tree.second)[0] ?? null;
  }
  if (tree.second.kind === "leaf" && tree.second.id === id) {
    return leafIds(tree.first)[0] ?? null;
  }
  return siblingLeaf(tree.first, id) ?? siblingLeaf(tree.second, id);
}

/**
 * Change the split that holds the window `id` (its parent). `change` gets
 * the split, the rect of the split, and true when `id` is the first child.
 * A tree where `id` has no parent comes back unchanged.
 */
function updateParentSplit(
  node: TileNode,
  rect: TileRect,
  gap: number,
  id: string,
  change: (split: TileSplit, rect: TileRect, idIsFirst: boolean) => TileSplit,
): TileNode {
  if (node.kind === "leaf") {
    return node;
  }
  if (node.first.kind === "leaf" && node.first.id === id) {
    return change(node, rect, true);
  }
  if (node.second.kind === "leaf" && node.second.id === id) {
    return change(node, rect, false);
  }
  const [first, second] = splitRect(rect, node.direction, node.ratio, gap);
  return {
    ...node,
    first: updateParentSplit(node.first, first, gap, id, change),
    second: updateParentSplit(node.second, second, gap, id, change),
  };
}

/** The widths Super+R steps through, as a share of a side-by-side split. */
export const TILED_WIDTH_SHARES = [1 / 3, 1 / 2, 2 / 3];

/**
 * Super+R: the focused window's column takes the next share of the page
 * width (1/3, 1/2, 2/3). The column is the side that holds `id` in the
 * nearest side-by-side split, so in a stack the whole stack changes. The
 * other columns get the rest and keep their sizes relative to each other,
 * so every window stays on the page. `step` 1 goes to the next bigger share
 * and wraps from 2/3 to 1/3; `step` -1 goes the other way. A share that
 * would put a window under the minimum size is skipped. The same tree comes
 * back when nothing changes.
 */
export function cycleWidthShare(
  tree: TileTree,
  id: string,
  step: 1 | -1,
  area: TileRect,
  gap: number,
  limits: TileLimits = DEFAULT_TILE_LIMITS,
): TileTree {
  if (!tree || !hasLeaf(tree, id)) {
    return tree;
  }
  // The side-by-side splits above `id`, from the top down.
  const rows: { split: TileSplit; width: number; inFirst: boolean }[] = [];
  let node: TileNode = tree;
  let rect = area;
  while (node.kind === "split") {
    const [firstRect, secondRect] = splitRect(rect, node.direction, node.ratio, gap);
    const inFirst = hasLeaf(node.first, id);
    if (node.direction === "row") {
      rows.push({ split: node, width: rect.width, inFirst });
    }
    node = inFirst ? node.first : node.second;
    rect = inFirst ? firstRect : secondRect;
  }
  if (rows.length === 0) {
    return tree;
  }
  // Width of the top split, and of the column and the other sides now.
  const total = rows[0].width;
  const sides = rows.map(({ split, width, inFirst }) => {
    const available = width - gap;
    const mine = available * (inFirst ? split.ratio : 1 - split.ratio);
    return { mine, other: available - mine };
  });
  const column = sides[sides.length - 1].mine;
  const others = sides.reduce((sum, side) => sum + side.other, 0);
  const gaps = rows.length * gap;
  // Shares are of the page width without the gaps between its columns,
  // so 1/2 is the same width for every column.
  const usable = total - (columnCount(rows[0].split) - 1) * gap;
  if (usable <= 0 || others <= 0) {
    return tree;
  }

  // How many columns sit side by side in the other side at each level.
  const otherColumns = rows.map(({ split, inFirst }) =>
    columnCount(inFirst ? split.second : split.first),
  );
  const allOtherColumns = otherColumns.reduce((sum, count) => sum + count, 0);

  // "scale": every other column scales by the same factor, so they keep
  // their sizes relative to each other. "even": the other columns share
  // the rest evenly (used when scaling would make one too narrow).
  const withShare = (share: number, mode: "scale" | "even"): TileTree => {
    const target = share * usable;
    const rest = total - gaps - target;
    const factor = rest / others;
    const innerGaps = otherColumns.reduce((sum, count) => sum + (count - 1) * gap, 0);
    const unit = (rest - innerGaps) / allOtherColumns;
    const ratios = new Map<TileSplit, number>();
    let inside = target;
    for (let level = rows.length - 1; level >= 0; level--) {
      const other =
        mode === "scale"
          ? sides[level].other * factor
          : otherColumns[level] * unit + (otherColumns[level] - 1) * gap;
      const ratio = inside / (inside + other);
      ratios.set(rows[level].split, rows[level].inFirst ? ratio : 1 - ratio);
      inside = inside + other + gap;
    }
    const onPath = new Set<TileSplit>(rows.map((row) => row.split));
    const rebuild = (current: TileNode, inOtherSide: boolean): TileNode => {
      if (current.kind === "leaf") {
        return current;
      }
      let ratio = ratios.get(current) ?? current.ratio;
      if (mode === "even" && inOtherSide && current.direction === "row") {
        // Even: the columns inside the other sides get the same width too.
        const first = columnCount(current.first);
        ratio = first / (first + columnCount(current.second));
      }
      const pathRow = onPath.has(current);
      const firstOther = inOtherSide || (pathRow && !hasLeaf(current.first, id));
      const secondOther = inOtherSide || (pathRow && !hasLeaf(current.second, id));
      return {
        ...current,
        ratio,
        first: rebuild(current.first, firstOther),
        second: rebuild(current.second, secondOther),
      };
    };
    return rebuild(tree, false);
  };

  let candidateTree: TileTree = tree;
  const next = nextShare(column / usable, step, (candidate) => {
    for (const mode of ["scale", "even"] as const) {
      candidateTree = withShare(candidate, mode);
      if (fitsMinSize(candidateTree, area, gap, limits)) {
        return true;
      }
    }
    return false;
  });
  return next === null ? tree : candidateTree;
}

/** How many columns sit side by side in `node`. */
function columnCount(node: TileNode): number {
  if (node.kind === "leaf") {
    return 1;
  }
  const first = columnCount(node.first);
  const second = columnCount(node.second);
  return node.direction === "row" ? first + second : Math.max(first, second);
}

/** The widths Super+R steps through for a window alone on its page. */
export const TILED_SOLO_SHARES = [1 / 3, 1 / 2, 2 / 3, 1];

/**
 * Super+R on a window alone on its page: the next width share of the page
 * (1/3, 1/2, 2/3, full). It skips a share under the min width. The window
 * sits on the left; the next window opens in the space on the right.
 */
export function cycleSoloShare(
  share: number,
  step: 1 | -1,
  area: TileRect,
  limits: TileLimits = DEFAULT_TILE_LIMITS,
): number {
  const next = nextShare(
    share,
    step,
    (candidate) => area.width * candidate >= limits.minWidth,
    TILED_SOLO_SHARES,
  );
  return next ?? share;
}

/**
 * Super+Minus / Super+Equal on a window alone on its page: `delta` more of
 * the page width, between the min width and the full width.
 */
export function resizeSoloShare(
  share: number,
  delta: number,
  area: TileRect,
  limits: TileLimits = DEFAULT_TILE_LIMITS,
): number {
  if (area.width <= 0) {
    return share;
  }
  const low = Math.min(1, limits.minWidth / area.width);
  return Math.min(1, Math.max(low, share + delta));
}

/**
 * The share after `share` in `shares`, going up (`step` 1) or down (-1)
 * and wrapping around, that `fits`. Null when none fits.
 */
function nextShare(
  share: number,
  step: 1 | -1,
  fits: (candidate: number) => boolean,
  shares: number[] = TILED_WIDTH_SHARES,
): number | null {
  const same = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const ascending = [...shares];
  const ahead =
    step === 1
      ? ascending.filter((s) => s > share && !same(s, share))
      : ascending.filter((s) => s < share && !same(s, share)).reverse();
  const behind =
    step === 1
      ? ascending.filter((s) => s <= share || same(s, share))
      : ascending.filter((s) => s >= share || same(s, share)).reverse();
  for (const candidate of [...ahead, ...behind]) {
    if (!same(candidate, share) && fits(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Flip the split that holds `id`: side by side <-> top and bottom. */
export function flip(tree: TileTree, id: string): TileTree {
  if (!tree) {
    return null;
  }
  const area = { x: 0, y: 0, width: 1, height: 1 };
  return updateParentSplit(tree, area, 0, id, (split) => ({
    ...split,
    direction: split.direction === "row" ? "column" : "row",
  }));
}

/**
 * Super+Comma: move `id` into a stack under `targetId`. The target's cell
 * is cut top and bottom; `id` goes below. The same tree comes back when a
 * window would go under the minimum size.
 */
export function stackOnto(
  tree: TileTree,
  id: string,
  targetId: string,
  area: TileRect,
  gap: number,
  limits: TileLimits = DEFAULT_TILE_LIMITS,
): TileTree {
  if (!tree || id === targetId || !hasLeaf(tree, id) || !hasLeaf(tree, targetId)) {
    return tree;
  }
  const rest = remove(tree, id);
  if (!rest) {
    return tree;
  }
  const next = replaceLeaf(rest, targetId, {
    kind: "split",
    direction: "column",
    ratio: 0.5,
    first: { kind: "leaf", id: targetId },
    second: { kind: "leaf", id },
  });
  return keepIfFits(tree, next, area, gap, limits);
}

/** True when `id` is in a stack: its own split is top and bottom. */
export function isStacked(tree: TileTree, id: string): boolean {
  const visit = (node: TileNode): boolean => {
    if (node.kind === "leaf") {
      return false;
    }
    const isChild =
      (node.first.kind === "leaf" && node.first.id === id) ||
      (node.second.kind === "leaf" && node.second.id === id);
    if (isChild) {
      return node.direction === "column";
    }
    return visit(hasLeaf(node.first, id) ? node.first : node.second);
  };
  return !!tree && hasLeaf(tree, id) && visit(tree);
}

/**
 * Take `id` out of its stack. Its stack (a top and bottom split) turns
 * into a side by side split in the same order: top goes left, bottom goes
 * right. So a stack and an unstack undo each other. The same tree comes
 * back when `id` is not in a stack or a window would get too small.
 */
export function unstack(
  tree: TileTree,
  id: string,
  area: TileRect,
  gap: number,
  limits: TileLimits = DEFAULT_TILE_LIMITS,
): TileTree {
  if (!tree || !hasLeaf(tree, id)) {
    return tree;
  }
  const visit = (node: TileNode): TileNode => {
    if (node.kind === "leaf") {
      return node;
    }
    const isFirst = node.first.kind === "leaf" && node.first.id === id;
    const isSecond = node.second.kind === "leaf" && node.second.id === id;
    if (isFirst || isSecond) {
      if (node.direction !== "column") {
        return node;
      }
      return {
        kind: "split",
        direction: "row",
        ratio: 0.5,
        first: node.first,
        second: node.second,
      };
    }
    return hasLeaf(node.first, id)
      ? { ...node, first: visit(node.first) }
      : { ...node, second: visit(node.second) };
  };
  return keepIfFits(tree, visit(tree), area, gap, limits);
}

/** `next`, unless it makes a window too small that was not too small before. */
function keepIfFits(
  tree: TileTree,
  next: TileTree,
  area: TileRect,
  gap: number,
  limits: TileLimits,
): TileTree {
  if (
    fitsMinSize(tree, area, gap, limits) &&
    !fitsMinSize(next, area, gap, limits)
  ) {
    return tree;
  }
  return next;
}

/**
 * The smallest size `node` can have along `axis` when no window in it goes
 * under the minimum size.
 */
function minSize(
  node: TileNode,
  axis: "width" | "height",
  gap: number,
  limits: TileLimits,
): number {
  if (node.kind === "leaf") {
    return axis === "width" ? limits.minWidth : limits.minHeight;
  }
  const first = minSize(node.first, axis, gap, limits);
  const second = minSize(node.second, axis, gap, limits);
  const alongAxis = (node.direction === "row") === (axis === "width");
  return alongAxis ? first + second + gap : Math.max(first, second);
}

/**
 * Move the divider of the split that holds `id`, so `id` gets `delta` more
 * of the split (less when `delta` is negative). The ratio stays between
 * TILED_MIN_RATIO and 1 - TILED_MIN_RATIO, and no window goes under the
 * minimum size. When no move is possible, the same tree comes back.
 */
export function resize(
  tree: TileTree,
  id: string,
  delta: number,
  area: TileRect,
  gap: number,
  limits: TileLimits = DEFAULT_TILE_LIMITS,
): TileTree {
  if (!tree) {
    return null;
  }
  let changed = false;
  const next = updateParentSplit(tree, area, gap, id, (split, rect, idIsFirst) => {
    const axis = split.direction === "row" ? "width" : "height";
    const available = rect[axis] - gap;
    if (available <= 0) {
      return split;
    }
    const low = Math.max(
      TILED_MIN_RATIO,
      minSize(split.first, axis, gap, limits) / available,
    );
    const high = Math.min(
      1 - TILED_MIN_RATIO,
      1 - minSize(split.second, axis, gap, limits) / available,
    );
    if (low > high) {
      // The split is already too small for its windows: leave it.
      return split;
    }
    const wanted = split.ratio + (idIsFirst ? delta : -delta);
    const ratio = Math.min(Math.max(wanted, low), high);
    if (Math.abs(ratio - split.ratio) < 1e-9) {
      return split;
    }
    changed = true;
    return { ...split, ratio };
  });
  if (!changed) {
    return tree;
  }
  // A nested split with an uneven ratio can still push a window under the
  // minimum. Then do not move the divider at all.
  if (
    fitsMinSize(tree, area, gap, limits) &&
    !fitsMinSize(next, area, gap, limits)
  ) {
    return tree;
  }
  return next;
}

/**
 * The window next to `id` in `direction`, by geometry. A candidate lies
 * fully on that side and overlaps `id` on the other axis. The nearest
 * candidate wins, then the one that overlaps most, then the most recently
 * focused, then rect order. Null at the screen edge.
 */
export function neighbour(
  rects: ReadonlyMap<string, TileRect>,
  id: string,
  direction: TileDirection,
  recentFocusOrder: readonly string[] = [],
): string | null {
  const from = rects.get(id);
  if (!from) {
    return null;
  }
  const horizontal = direction === "left" || direction === "right";
  const candidates: { id: string; distance: number; overlap: number; recency: number }[] = [];
  for (const [otherId, rect] of rects) {
    if (otherId === id) {
      continue;
    }
    const distance =
      direction === "left"
        ? from.x - (rect.x + rect.width)
        : direction === "right"
          ? rect.x - (from.x + from.width)
          : direction === "up"
            ? from.y - (rect.y + rect.height)
            : rect.y - (from.y + from.height);
    if (distance < -EDGE_TOLERANCE) {
      continue;
    }
    const overlap = horizontal
      ? Math.min(from.y + from.height, rect.y + rect.height) - Math.max(from.y, rect.y)
      : Math.min(from.x + from.width, rect.x + rect.width) - Math.max(from.x, rect.x);
    if (overlap <= EDGE_TOLERANCE) {
      continue;
    }
    const recency = recentFocusOrder.indexOf(otherId);
    candidates.push({
      id: otherId,
      distance,
      overlap,
      recency: recency < 0 ? Number.POSITIVE_INFINITY : recency,
    });
  }
  candidates.sort((a, b) => {
    if (Math.abs(a.distance - b.distance) > EDGE_TOLERANCE) {
      return a.distance - b.distance;
    }
    if (Math.abs(a.overlap - b.overlap) > EDGE_TOLERANCE) {
      return b.overlap - a.overlap;
    }
    if (a.recency !== b.recency) {
      return a.recency - b.recency;
    }
    return 0;
  });
  return candidates[0]?.id ?? null;
}

/** Swap the places of the windows `a` and `b`. */
export function swap(tree: TileTree, a: string, b: string): TileTree {
  if (!tree) {
    return null;
  }
  // Two windows of one split trade places and keep their sizes: the
  // divider moves with them (a 2/3 | 1/3 pair becomes 1/3 | 2/3).
  if (
    tree.kind === "split" &&
    tree.first.kind === "leaf" &&
    tree.second.kind === "leaf" &&
    ((tree.first.id === a && tree.second.id === b) ||
      (tree.first.id === b && tree.second.id === a))
  ) {
    return { ...tree, first: tree.second, second: tree.first, ratio: 1 - tree.ratio };
  }
  if (tree.kind === "leaf") {
    if (tree.id === a) {
      return { kind: "leaf", id: b };
    }
    if (tree.id === b) {
      return { kind: "leaf", id: a };
    }
    return tree;
  }
  return {
    ...tree,
    first: swap(tree.first, a, b) ?? tree.first,
    second: swap(tree.second, a, b) ?? tree.second,
  };
}

/**
 * Build a tree from `ids` in order, as if each window opened after the one
 * before it and took the focus. No limits: every id gets a place.
 */
export function buildTree(
  ids: readonly string[],
  area: TileRect,
  gap: number,
): TileTree {
  let tree: TileTree = null;
  let focusedId: string | null = null;
  for (const id of ids) {
    tree = insert(tree, id, { area, gap, focusedId });
    focusedId = id;
  }
  return tree;
}
