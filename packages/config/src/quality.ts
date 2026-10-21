import { computed, signal } from "shoji_wm";

/**
 * Automatic effect quality.
 *
 * Animations must stay smooth on any machine: a late frame is worse than a
 * missing effect. The animations (Magic Lamp, wobbly drag) report the time
 * between their frames here. When too many frames come late, the quality
 * goes down one level; after a while it tries one level up again.
 *
 *   0 FULL     every effect
 *   1 LIGHT    no glass, no blur, no shadows
 *   2 MINIMAL  also no Magic Lamp and no wobbly drag
 */
export const QUALITY_FULL = 0;
export const QUALITY_LIGHT = 1;
export const QUALITY_MINIMAL = 2;

/** How many recent animation frames decide. */
const WINDOW_FRAMES = 90;
/** Fewer frames than this decide nothing yet. */
const MIN_FRAMES = 45;
/** A frame is late when it takes this many normal frame times or more. */
const LATE_FACTOR = 1.5;
/** More late frames than this share lowers the quality. */
const MAX_LATE_SHARE = 0.05;
/** The first try one level up comes this long after a step down. */
const RETRY_FIRST_MS = 2 * 60 * 1000;
/** Each failed try doubles the wait, up to this. */
const RETRY_MAX_MS = 30 * 60 * 1000;

const [level, setLevel] = signal(QUALITY_FULL);
const deltas: number[] = [];
let retryAtMs: number | null = null;
let retryWaitMs = RETRY_FIRST_MS;
/** The level the last step down came from, to know if a try failed. */
let triedLevel: number | null = null;

/** The current quality level (reactive). */
export const qualityLevel = computed(() => level());

/** True when the quality is LIGHT or lower (reactive). */
export const qualityLight = computed(() => level() >= QUALITY_LIGHT);

/** True when the quality is MINIMAL (reactive). */
export const qualityMinimal = computed(() => level() >= QUALITY_MINIMAL);

/** Recent decisions, for the debug IPC. */
const history: { atMs: number; level: number; lateShare: number }[] = [];

/** The quality state, for the debug IPC. */
export function qualityDebug() {
  return { level: level.peek(), retryAtMs, retryWaitMs, frames: deltas.length, history };
}

function changeLevel(next: number, nowMs: number, lateShare: number) {
  setLevel(next);
  deltas.length = 0;
  history.push({ atMs: nowMs, level: next, lateShare: Math.round(lateShare * 1000) / 10 });
  if (history.length > 20) {
    history.shift();
  }
}

/**
 * Take the try one level up when it is due. An effect calls this before it
 * reads the level: at MINIMAL no animation runs, so no frame would ever
 * reach `recordAnimationFrame` and the quality would stay down for good.
 */
export function retryQualityIfDue(nowMs: number = Date.now()) {
  if (retryAtMs !== null && nowMs >= retryAtMs && level.peek() > QUALITY_FULL) {
    retryAtMs = null;
    triedLevel = level.peek() - 1;
    changeLevel(triedLevel, nowMs, 0);
  }
}

/**
 * Report the time since the previous frame of a running animation (ms).
 * Pass 0 for the first frame of an animation; it is ignored.
 */
export function recordAnimationFrame(deltaMs: number, nowMs: number = Date.now()) {
  retryQualityIfDue(nowMs);
  if (deltaMs <= 0) {
    return;
  }
  deltas.push(deltaMs);
  if (deltas.length > WINDOW_FRAMES) {
    deltas.shift();
  }
  if (deltas.length < MIN_FRAMES) {
    return;
  }

  // The normal frame time: the fastest tenth of the recent frames.
  const sorted = [...deltas].sort((a, b) => a - b);
  const normalMs = sorted[Math.floor(sorted.length / 10)];
  const late = deltas.filter((delta) => delta >= normalMs * LATE_FACTOR).length;
  const lateShare = late / deltas.length;
  if (lateShare <= MAX_LATE_SHARE) {
    // This level holds up: a later try up waits as long as the first one.
    if (triedLevel === level.peek()) {
      triedLevel = null;
      retryWaitMs = RETRY_FIRST_MS;
    }
    return;
  }
  if (level.peek() >= QUALITY_MINIMAL) {
    return;
  }
  // Too slow: one level down. A failed try up waits twice as long next time.
  if (triedLevel === level.peek()) {
    retryWaitMs = Math.min(retryWaitMs * 2, RETRY_MAX_MS);
  }
  triedLevel = null;
  changeLevel(level.peek() + 1, nowMs, lateShare);
  retryAtMs = nowMs + retryWaitMs;
}
