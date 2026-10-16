import { computed, signal } from "shoji_wm";

/**
 * Which window animations run now (Magic Lamp, wobbly drag, tile moves).
 *
 * The glass blur behind a moving window must be redone on every frame. When
 * another program (a training job, a game) keeps the GPU busy, that extra
 * work makes the animation drop frames. The config pauses the glass while
 * any animation runs, and the glass comes back when the last one ends.
 */
const running = new Set<string>();
const [count, setCount] = signal(0);

/** True while any window animation runs (reactive). */
export const animationRunning = computed(() => count() > 0);

/** Mark the animation `kind` of window `windowId` as running or stopped. */
export function setAnimationRunning(kind: string, windowId: string, on: boolean) {
  const key = `${kind}:${windowId}`;
  if (on) {
    running.add(key);
  } else {
    running.delete(key);
  }
  if (count.peek() !== running.size) {
    setCount(running.size);
  }
}
