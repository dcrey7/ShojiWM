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
