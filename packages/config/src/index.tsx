import {
  AppIcon,
  Box,
  Button,
  ClientWindow,
  Image,
  ShaderEffect,
  Label,
  COMPOSITOR,
  createPoll,
  type PollHandle,
  WindowBorder,
  backdropSource,
  compileEffect,
  compileLayerEffect,
  dualKawaseBlur,
  type SSDStyle,
  type WaylandWindow,
  type PlasmaSurfaceRole,
  type PlasmaSurfaceState,
  computed,
  signal,
  useState,
  shaderStage,
  loadShader,
  layerSource,
  ManagedWindow,
  read,
  type DisplayConfigDraft,
  compilePopupEffect,
  popupSource,
  type ReadonlySignal,
  DefaultComposition,
  animationVariable,
  cubicBezier,
  easeOut,
  linear,
  paintShader,
} from "shoji_wm";
import type {
  CompositionRenderable,
  ManagedWindowRect,
  WindowDecorationState,
} from "shoji_wm/types";
import { createIpcServer, defaultSocketPath } from "shoji_wm/ipc";
import {
  HybridWindowManager,
  configureEvenTileSplit,
  isTileable,
  TITLEBAR_HEIGHT,
  WINDOW_BORDER_PX,
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_TAB_DRAG_SCALE,
  WINDOW_STATE_TILE_DRAGGING,
  WINDOW_STATE_TILE_REORDERING,
  WINDOW_STATE_TILED,
  WINDOW_STATE_WORKSPACE_TILED,
  WINDOW_STATE_VISIBLE_OUTPUTS,
  WINDOW_STATE_RECT,
  WINDOW_STATE_WORKSPACE_VISIBLE,
  WINDOW_STATE_WORKSPACE_OFFSET_X,
  WINDOW_STATE_WORKSPACE_OPACITY,
} from "./window-manager";
import { ISLAND_GLASS } from "./effect/island-glass";
import { qualityDebug, qualityLight, setQualityLevel } from "./quality";
import { tabDragDebug } from "./window-manager";
import { createCoverflow } from "./coverflow";
import { createFlip3D } from "./flip-3d";
import { broadcastSwitcherLabel } from "./switcher-label";
import { createWindowGrid, createWindowView } from "./window-grid";
import { bindKeymap, createKeymap, keymapRows, runChord, writeKeymapFile } from "./keymap";
import { MARGIN as SWITCHER_MARGIN, type TitlebarButton } from "./window-switcher";
import {
  jellyDragDebug,
  jellyDragEffect,
  jellyDragForget,
  jellyDragOnWindowMove,
} from "./jelly-drag";
import {
  configureMagicLamp,
  magicLampEffect,
  magicLampDebug,
  magicLampForget,
  magicLampRunning,
} from "./magic-lamp";
import {
  configureSlidingPopups,
  slidePopupIn,
  slidePopupOut,
  slidingPopupsDebug,
} from "./sliding-popups";

COMPOSITOR.env.apply({
  QT_QPA_PLATFORM: "wayland;xcb",
  // Follow the KDE theme (Breeze dark) instead of qt6ct.
  QT_QPA_PLATFORMTHEME: "kde",
  QT_IM_MODULE: "fcitx",
  XMODIFIERS: "@im=fcitx",
  SDL_IM_MODULE: "fcitx",
  GLFW_IM_MODULE: "ibus",
  ELECTRON_OZONE_PLATFORM_HINT: "wayland",
});
// A Global Theme picked in System Settings writes its values into
// ~/.config/kdedefaults; startplasma puts that folder first in
// XDG_CONFIG_DIRS so KDE apps read it. Do the same, or the pick only half
// applies (the Plasma theme stays, icons and widget style get lost).
{
  const kdeDefaults = `${COMPOSITOR.env.get("HOME") ?? ""}/.config/kdedefaults`;
  const dirs = COMPOSITOR.env.get("XDG_CONFIG_DIRS") || "/etc/xdg";
  if (!dirs.split(":").includes(kdeDefaults)) {
    COMPOSITOR.env.set("XDG_CONFIG_DIRS", `${kdeDefaults}:${dirs}`);
  }
}
COMPOSITOR.env.publish();

COMPOSITOR.cursor.configure({
  theme: "breeze_cursors", // KDE default cursor, like Abhishek's KDE
  size: 24,
  // Konsole hides the cursor 5 s after the mouse stops, so it vanished
  // during voice dictation. Keep it visible there.
  keepVisibleFor: ["org.kde.konsole"],
});

COMPOSITOR.process.once("GTK-CSD-control-buttons", {
  command: "gsettings set org.gnome.desktop.wm.preferences button-layout ':minimize,maximize,close'",
  runPolicy: "once-per-session",
});

COMPOSITOR.window.decoration.configure((window, context) => {
  // plasmashell draws its popups and panels itself: no title bar on them.
  if (isPlasmaShellWindow(window)) {
    return { mode: "client" };
  }
  return { mode: context.clientPreference ?? "server" };
});

/**
 * plasmashell's own windows: Kickoff, tray popups, the calendar, OSDs,
 * notifications, tooltips, and the taskbar's list of grouped windows. KDE's
 * plasma-shell protocol gives each one a role and a screen position. The
 * grouped-window list keeps the role "normal" but asks for a position, so a
 * position alone also marks a shell window.
 *
 * The window manager never sees them: no tiling, no workspace, no window
 * switcher, no title bar. They sit where plasmashell asks, above normal
 * windows (see `plasmaShellComposition`).
 */
function isPlasmaShellSurface(plasma: PlasmaSurfaceState | undefined): boolean {
  return (
    plasma !== undefined && (plasma.role !== "normal" || plasma.x !== undefined)
  );
}

function isPlasmaShellWindow(window: WaylandWindow): boolean {
  return isPlasmaShellSurface(window.plasma.peek());
}

/**
 * The last focus changes, shell window opens and closes, and pointer target
 * changes, for `debug.focus`: a flicker on hover was focus flipping.
 */
const FOCUS_DEBUG_LIMIT = 200;
const focusDebugEvents: Array<Record<string, unknown>> = [];
function noteFocusDebug(event: Record<string, unknown>) {
  focusDebugEvents.push({ t: Date.now(), ...event });
  if (focusDebugEvents.length > FOCUS_DEBUG_LIMIT) {
    focusDebugEvents.shift();
  }
}
/** Who a window is, for `debug.focus`. */
function focusDebugName(window: WaylandWindow) {
  const plasma = window.plasma.peek();
  return {
    id: window.id,
    app: window.appId.peek(),
    role: plasma?.role,
    shell: isPlasmaShellSurface(plasma),
  };
}

/**
 * plasmashell windows that have the keyboard now. The pointer leaves focus
 * alone while any has it. One flag was not enough: when the panel lost focus
 * just after Kickoff got it, the panel's "lost" turned the pause off, the
 * pointer gave focus back to the window under it, and the menu closed and
 * reopened on every hover.
 */
const FOCUSED_SHELL_WINDOWS = new Set<string>();
function syncPointerFocusPause() {
  HYBRID_WINDOW_MANAGER.setPointerFocusPaused(FOCUSED_SHELL_WINDOWS.size > 0);
}

/** plasmashell's open windows, by id (filled by the open and close events). */
const PLASMA_SHELL_WINDOWS = new Map<string, WaylandWindow>();

/** plasmashell's open windows with this role (e.g. the panels, the desktop). */
function plasmaShellWindows(role: PlasmaSurfaceRole): WaylandWindow[] {
  return [...PLASMA_SHELL_WINDOWS.values()].filter(
    (window) => window.plasma.peek()?.role === role,
  );
}

/** Shell windows that need the keyboard as soon as they open. */
function plasmaShellWindowTakesFocus(window: WaylandWindow): boolean {
  const plasma = window.plasma.peek();
  // Kickoff, the applet popups and the grouped-window list have search
  // fields and lists, and plasmashell closes them when they lose focus.
  return (
    plasma?.role === "appletpopup" ||
    plasma?.role === "normal" ||
    (plasma?.role === "panel" && plasma.panelTakesFocus)
  );
}

// enable triple buffer mode for massive performance
COMPOSITOR.rendering.framePacing = "throughput";

const HYBRID_WINDOW_MANAGER = new HybridWindowManager(naturalRootRect);

// Window switcher (Super+Tab): "coverflow" is GNOME's Coverflow Alt-Tab
// (./coverflow.tsx), "flip-3d" stacks the windows in 3D (./flip-3d.tsx),
// "grid" lays them out side by side (./window-grid.tsx).
const WINDOW_SWITCHER_STYLE = "coverflow" as "coverflow" | "flip-3d" | "grid";
const WINDOW_SWITCHER = (
  WINDOW_SWITCHER_STYLE === "grid"
    ? createWindowGrid
    : WINDOW_SWITCHER_STYLE === "flip-3d"
      ? createFlip3D
      : createCoverflow
)({
  windowManager: HYBRID_WINDOW_MANAGER,
  stackOrder: (window) =>
    window.state[WINDOW_STATE_FULLSCREEN]()
      ? FULLSCREEN_Z_INDEX
      : windowZIndex(window),
  titlebarButtonAt: (window, x, y) => titlebarButtonAt(window, x, y),
});
// KDE's Window View: the taskbar's "show windows side by side" for a group
// of windows (see the `windowView.activate` IPC command).
const WINDOW_VIEW = createWindowView({
  windowManager: HYBRID_WINDOW_MANAGER,
  stackOrder: (window) =>
    window.state[WINDOW_STATE_FULLSCREEN]()
      ? FULLSCREEN_Z_INDEX
      : windowZIndex(window),
  titlebarButtonAt: (window, x, y) => titlebarButtonAt(window, x, y),
});
// Super+Tab: every window of every app side by side, in rows and columns.
const WINDOW_GRID = createWindowGrid({
  windowManager: HYBRID_WINDOW_MANAGER,
  stackOrder: (window) =>
    window.state[WINDOW_STATE_FULLSCREEN]()
      ? FULLSCREEN_Z_INDEX
      : windowZIndex(window),
  titlebarButtonAt: (window, x, y) => titlebarButtonAt(window, x, y),
});
COMPOSITOR.rendering.composition = (output) =>
  WINDOW_SWITCHER.compose(output) ??
  WINDOW_GRID.compose(output) ??
  WINDOW_VIEW.compose(output) ?? <DefaultComposition />;

/** What the switchers share with the rest of the config. */
const SWITCHERS = {
  blurSuspended: computed(
    () =>
      WINDOW_SWITCHER.blurSuspended() ||
      WINDOW_GRID.blurSuspended() ||
      WINDOW_VIEW.blurSuspended(),
  ),
  backdropStrength: computed(() =>
    Math.min(
      WINDOW_SWITCHER.backdropStrength(),
      WINDOW_GRID.backdropStrength(),
      WINDOW_VIEW.backdropStrength(),
    ),
  ),
  // All glow the same white around the selected window.
  selectedWindowId: computed(
    () =>
      WINDOW_SWITCHER.selectedWindowId() ??
      WINDOW_GRID.selectedWindowId() ??
      WINDOW_VIEW.selectedWindowId(),
  ),
};

// No glass while a switcher is open, or when the machine is too slow for it
// (quality.ts). It does not pause for every animation: that swapped every
// title bar between a plain box and the glass effect at the start and end of
// each animation, a rebuild of every window on exactly the frames that must
// be smooth. The quality guard turns the glass off if the GPU falls behind.
const GLASS_PAUSED = computed(
  () => SWITCHERS.blurSuspended() || qualityLight(),
);

// Window backdrop effects end with this stage so they can fade back in after
// the switcher closes.
const backdropFade = () =>
  shaderStage(loadShader("./src/effect/backdrop-fade.frag"), {
    uniforms: { strength: SWITCHERS.backdropStrength },
  });
const HOT_RELOAD_WINDOW_MANAGER_STATE = "config.hybrid-window-manager";
const FULLSCREEN_Z_INDEX = 2_000_000_000;
/** A window in the Magic Lamp: over fullscreen windows, under the panel. */
const MAGIC_LAMP_Z_INDEX = 2_010_000_000;
/** Stack order inside the lamp band: stays over fullscreen and under the panel. */
const MAGIC_LAMP_Z_INDEX_RANGE = 9_000_000;
const FLOATING_WINDOW_Z_INDEX_BASE = 1_500_000_000;
const WINDOW_STACK_Z_INDEX_RANGE = 100_000_000;
const FOCUSED_TILED_WINDOW_Z_INDEX = 1_000_000_000;
/**
 * A tile being dragged, and a tab Chrome drags out from its opening until its
 * shrink back ends: above the focused tile, because Chrome hands the focus
 * back and forth with the window the tab came from. Below the Magic Lamp.
 */
const DRAGGED_WINDOW_Z_INDEX = 1_500_000_000;
const REORDERING_TILED_WINDOW_Z_INDEX = -2_000_000_000;

/** Where a (non-fullscreen) window sits in the stack; higher is on top. */
function windowZIndex(window: WaylandWindow): number {
  const stackZIndex = HYBRID_WINDOW_MANAGER.getWindowZIndex(window)();
  if (magicLampRunning(window)) {
    // Like KWin: the window keeps its place on top while it pours into its
    // icon, even after focus moves on. KWin's panel stays above it. Two
    // windows in the lamp at once (two apps opening) keep their stack order.
    return (
      MAGIC_LAMP_Z_INDEX +
      Math.max(-MAGIC_LAMP_Z_INDEX_RANGE, Math.min(MAGIC_LAMP_Z_INDEX_RANGE, stackZIndex))
    );
  }
  const stackOffset = Math.max(
    -WINDOW_STACK_Z_INDEX_RANGE,
    Math.min(WINDOW_STACK_Z_INDEX_RANGE, stackZIndex),
  );
  if (
    window.state[WINDOW_STATE_TILE_DRAGGING]() ||
    HYBRID_WINDOW_MANAGER.keepsTabWindowOnTop(window)
  ) {
    return DRAGGED_WINDOW_Z_INDEX + stackOffset;
  }
  if (!window.state[WINDOW_STATE_WORKSPACE_TILED]()) {
    return stackZIndex;
  }
  if (!window.state[WINDOW_STATE_TILED]()) {
    return FLOATING_WINDOW_Z_INDEX_BASE + stackOffset;
  }
  if (window.state[WINDOW_STATE_TILE_REORDERING]()) {
    return REORDERING_TILED_WINDOW_Z_INDEX;
  }
  return window.isFocused() ? FOCUSED_TILED_WINDOW_Z_INDEX : stackOffset;
}

COMPOSITOR.onDisable((event) => {
  if (event.isReloading) {
    const snapshot = HYBRID_WINDOW_MANAGER.snapshot();
    event.persist(HOT_RELOAD_WINDOW_MANAGER_STATE, snapshot);
  }
  HYBRID_WINDOW_MANAGER.dispose();
});

COMPOSITOR.onEnable((event) => {
  if (event.isReloading) {
    const snapshot = event.restore<
      ReturnType<typeof HYBRID_WINDOW_MANAGER.snapshot>
    >(HOT_RELOAD_WINDOW_MANAGER_STATE);
    if (snapshot) {
      HYBRID_WINDOW_MANAGER.restore(snapshot);
    }
  }
});

// ---------------------------------------------------------------------------
// External IPC: expose the workspace layout to clients such as the bar.
//   workspaces.get           -> WorkspacesView                     (request/response)
//   workspaces.switch        { direction: -1 | 1 }                 (command)
//   workspaces.activate      { monitor: string, index: number }    (command)
//   workspaces.toggleTiling  { monitor?: string }                  (command)
//   workspaces.changed       -> WorkspacesView                     (broadcast)
//   windows.activate         { windowId: string }                  (command)
//   windows.minimize         { windowId: string }                  (command)
//   windowView.activate      { windowIds: string[] }               (command)
//   windowView.deactivate                                          (command)
//   dock.proximity           { monitor: string, inside: bool }    (broadcast)
// ---------------------------------------------------------------------------
const WORKSPACE_IPC = createIpcServer();
let lastWorkspacesJson = "";
let workspaceBroadcastQueued = false;

function broadcastWorkspaces() {
  const view = HYBRID_WINDOW_MANAGER.viewForIpc();
  const json = JSON.stringify(view);
  if (json === lastWorkspacesJson) {
    return;
  }
  lastWorkspacesJson = json;
  WORKSPACE_IPC.broadcast("workspaces.changed", view);
}

function reconfigureProtocolWorkspaces() {
  COMPOSITOR.workspace.reconfigure();
}

// Coalesce many state mutations within one tick into a single diffed broadcast.
function scheduleWorkspaceBroadcast() {
  // Protocol state must be staged before the current runtime response is
  // written; otherwise key bindings/Waybar activations only reach external
  // bars on a later, unrelated runtime request.
  reconfigureProtocolWorkspaces();
  if (workspaceBroadcastQueued) {
    return;
  }
  workspaceBroadcastQueued = true;
  void Promise.resolve().then(() => {
    workspaceBroadcastQueued = false;
    broadcastWorkspaces();
  });
}

COMPOSITOR.workspace.configure(() => {
  const view = HYBRID_WINDOW_MANAGER.viewForIpc();
  return {
    groups: view.monitors.map((monitor) => ({
      id: monitor.name,
      outputs: [monitor.name],
      workspaces: monitor.workspaces.map((workspace) => ({
        id: `${monitor.name}:${workspace.index}`,
        name: String(workspace.index),
        coordinates: [Math.max(0, workspace.index - 1)],
        active: workspace.active,
        hidden: !workspace.active && workspace.windowCount === 0,
      })),
    })),
    virtualDesktops: virtualDesktops(view),
  };
});

/**
 * KDE's virtual desktops for the bar's workspace pills: workspaces 1 to N
 * of the current monitor. Workspaces are dynamic (no gaps, empty ones go
 * away), so N is the number of workspaces and desktop N is workspace N.
 */
const MIN_PAGER_DESKTOPS = 1;
function virtualDesktops(view: ReturnType<typeof HYBRID_WINDOW_MANAGER.viewForIpc>) {
  const monitorName = HYBRID_WINDOW_MANAGER.getCurrentMonitorName();
  const monitor = view.monitors.find((candidate) => candidate.name === monitorName);
  const workspaces = monitor?.workspaces ?? [];
  const count = Math.max(MIN_PAGER_DESKTOPS, ...workspaces.map((workspace) => workspace.index));
  const desktops = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const workspace = workspaces.find((candidate) => candidate.index === index);
    return {
      id: `${monitorName}:${index}`,
      name: `Desktop ${index}`,
      active: workspace?.active ?? false,
      windowIds: workspace?.windows.map((window) => window.id) ?? [],
    };
  });
  const minimizedWindowIds = desktops
    .flatMap((desktop) => desktop.windowIds)
    .filter((id) => {
      const window = HYBRID_WINDOW_MANAGER.findWindowById(id);
      return window?.state[WINDOW_STATE_MINIMIZED].peek() === true;
    });
  return { desktops, rows: 1, minimizedWindowIds };
}

/** A workspace id "MONITOR:INDEX" as [monitor, index]; `null` when malformed. */
function parseWorkspaceId(workspaceId: string): [string, number] | null {
  const [monitor, rawIndex] = workspaceId.split(":");
  const index = Number(rawIndex);
  if (!monitor || !Number.isInteger(index) || index < 1) {
    return null;
  }
  return [monitor, index];
}

COMPOSITOR.workspace.event.onActivate((event) => {
  const target = parseWorkspaceId(event.workspaceId);
  if (!target) {
    return;
  }
  HYBRID_WINDOW_MANAGER.activate(target[0], target[1]);
  scheduleWorkspaceBroadcast();
});

// KDE's Pager drag or the taskbar's "move to desktop": move the window.
COMPOSITOR.workspace.event.onMoveWindow((event) => {
  const target = parseWorkspaceId(event.workspaceId);
  const window = HYBRID_WINDOW_MANAGER.findWindowById(event.windowId);
  if (!target || !window) {
    return;
  }
  HYBRID_WINDOW_MANAGER.moveWindowToWorkspace(window, target[0], target[1]);
  scheduleWorkspaceBroadcast();
});

WORKSPACE_IPC.handle("workspaces.get", () =>
  HYBRID_WINDOW_MANAGER.viewForIpc(),
);
WORKSPACE_IPC.handle("workspaces.switch", (params) => {
  const direction = (params as { direction?: number } | undefined)?.direction;
  HYBRID_WINDOW_MANAGER.switchWorkspace(direction === -1 ? -1 : 1);
  scheduleWorkspaceBroadcast();
});
WORKSPACE_IPC.handle("workspaces.activate", (params) => {
  const request = params as { monitor?: string; index?: number } | undefined;
  if (request?.monitor && typeof request.index === "number") {
    HYBRID_WINDOW_MANAGER.activate(request.monitor, request.index);
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("workspaces.toggleTiling", (params) => {
  const monitor = (params as { monitor?: string } | undefined)?.monitor;
  if (monitor) {
    HYBRID_WINDOW_MANAGER.toggleWorkspaceTilingForMonitor(monitor);
  } else {
    HYBRID_WINDOW_MANAGER.toggleCurrentWorkspaceTiling();
  }
  scheduleWorkspaceBroadcast();
});
WORKSPACE_IPC.handle("windows.activate", (params) => {
  const windowId = (params as { windowId?: string } | undefined)?.windowId;
  if (typeof windowId === "string") {
    HYBRID_WINDOW_MANAGER.activateWindowById(windowId);
    scheduleWorkspaceBroadcast();
  }
});

// A window's rect in global logical px, for ./helpers/screenshot-dbus.py
// (Spectacle's "active window" capture). Null when the window is gone.
WORKSPACE_IPC.handle("windows.rect", (params) => {
  const windowId = (params as { windowId?: string } | undefined)?.windowId;
  const window =
    typeof windowId === "string"
      ? HYBRID_WINDOW_MANAGER.findWindowById(windowId)
      : undefined;
  if (!window) {
    return null;
  }
  const { x, y, width, height } = window.rect;
  return { x, y, width, height };
});

WORKSPACE_IPC.handle("windows.minimize", (params) => {
  const windowId = (params as { windowId?: string } | undefined)?.windowId;
  if (typeof windowId === "string") {
    HYBRID_WINDOW_MANAGER.findWindowById(windowId)?.minimize();
  }
});

// KDE's Window View for a taskbar group ("show windows side by side"):
// plasmashell calls org.kde.KWin.Effect.WindowView1.activate with the
// windows' ids, and ./helpers/window-view-dbus.py hands them on to here.
WORKSPACE_IPC.handle("windowView.activate", (params) => {
  const ids = (params as { windowIds?: unknown } | undefined)?.windowIds;
  if (!Array.isArray(ids) || SWITCHERS.blurSuspended.peek()) {
    // Bad call, or a switcher is already open.
    return;
  }
  const windows = ids
    .map((id) => HYBRID_WINDOW_MANAGER.findWindowById(String(id)))
    .filter((window) => window !== undefined);
  WINDOW_VIEW.open(HYBRID_WINDOW_MANAGER.getCurrentMonitorName(), windows);
});

WORKSPACE_IPC.handle("windowView.deactivate", () => WINDOW_VIEW.cancel());

// Debug: a pointer motion or press (`button`: "left" / "middle") in the open
// Window View, at global logical `x`, `y`. Tests use it instead of the real
// pointer. Returns the card hit, false for none, null when the view is shut.
WORKSPACE_IPC.handle("debug.windowViewPointer", (params) => {
  const { x, y, button } = (params ?? {}) as {
    x?: number;
    y?: number;
    button?: "left" | "middle";
  };
  if (typeof x !== "number" || typeof y !== "number") {
    return null;
  }
  return WINDOW_VIEW.debugPointer(x, y, button);
});

// Debug: drive the window switcher without the real keyboard. `action`:
// "open", "key" (`key`, `shift`) or "cancel". Returns the selected window's id.
// "open" takes `switcher: "grid"` for the Super+Tab grid, and `windowIds` to
// show only those windows, in recent-use order (demo recordings).
WORKSPACE_IPC.handle("debug.windowSwitcher", (params) => {
  const { action, key, shift, x, y, button, switcher, windowIds } = (params ?? {}) as {
    action?: "open" | "key" | "cancel" | "pointer";
    key?: string;
    shift?: boolean;
    x?: number;
    y?: number;
    button?: "left" | "middle";
    switcher?: "coverflow" | "grid";
    windowIds?: string[];
  };
  if (action === "open") {
    const target = switcher === "grid" ? WINDOW_GRID : WINDOW_SWITCHER;
    const only = Array.isArray(windowIds)
      ? HYBRID_WINDOW_MANAGER.listWindowsByRecentUse().filter((window) =>
          windowIds.includes(window.id),
        )
      : undefined;
    target.open(HYBRID_WINDOW_MANAGER.getCurrentMonitorName(), only);
  } else if (action === "cancel") {
    WINDOW_SWITCHER.cancel();
    WINDOW_GRID.cancel();
  } else if (action === "key" && typeof key === "string") {
    return WINDOW_SWITCHER.debugKey(key, shift);
  } else if (action === "pointer" && typeof x === "number" && typeof y === "number") {
    return WINDOW_SWITCHER.debugPointer(x, y, button);
  }
  return SWITCHERS.selectedWindowId.peek();
});

// Coverflow's title under the selected card, drawn by
// ./helpers/switcher-label.py (started below).
if (WINDOW_SWITCHER_STYLE === "coverflow") {
  broadcastSwitcherLabel(WORKSPACE_IPC, WINDOW_SWITCHER, HYBRID_WINDOW_MANAGER);
}

// Debug: the last Magic Lamp runs with frame times; `durationMs` slows it.
// Debug: slow the sliding popups down (`durationMs`), `null` restores KWin's.
WORKSPACE_IPC.handle("debug.slidingPopups", (params) => {
  slidingPopupsDebug((params as { durationMs?: number | null } | undefined)?.durationMs ?? null);
});

WORKSPACE_IPC.handle("debug.wobble", () => ({ runs: jellyDragDebug() }));
WORKSPACE_IPC.handle("debug.quality", () => qualityDebug());
WORKSPACE_IPC.handle("debug.tabDrag", () => ({ events: tabDragDebug() }));
WORKSPACE_IPC.handle("debug.focus", () => ({
  events: focusDebugEvents,
  focusedShellWindows: [...FOCUSED_SHELL_WINDOWS],
  // The shell windows open now: a stuck tooltip or preview shows up here.
  shellWindows: [...PLASMA_SHELL_WINDOWS.values()].map((window) => ({
    ...focusDebugName(window),
    rect: window.rect,
    focused: window.isFocused.peek(),
  })),
}));
// Runs what the title bar's maximize button runs, for tests with no pointer.
WORKSPACE_IPC.handle("debug.maximizeButton", (params) => {
  const windowId = (params as { windowId?: string } | undefined)?.windowId;
  const window =
    typeof windowId === "string" ? HYBRID_WINDOW_MANAGER.findWindowById(windowId) : undefined;
  if (!window) {
    return null;
  }
  const before = read(window.isMaximized);
  toggleMaximize(window);
  return { before, after: read(window.isMaximized), resizable: read(window.isResizable) };
});

// Grows a traffic light like a hover does, for tests with no pointer.
WORKSPACE_IPC.handle("debug.trafficLightGrow", (params) => {
  const { windowId, kind, to, durationMs } = (params ?? {}) as {
    windowId?: string;
    kind?: keyof typeof TRAFFIC_LIGHT_GROW;
    to?: number;
    durationMs?: number;
  };
  const window =
    typeof windowId === "string" ? HYBRID_WINDOW_MANAGER.findWindowById(windowId) : undefined;
  const grow = TRAFFIC_LIGHT_GROW[kind ?? "close"];
  if (!window || !grow) {
    return null;
  }
  window.animation.start(grow, {
    duration: Math.max(1, durationMs ?? TRAFFIC_LIGHT_GROW_MS),
    to: to ?? TRAFFIC_LIGHT_HOVER_GROW,
    easing: TRAFFIC_LIGHT_HOVER_EASING,
  });
  return { started: true };
});

WORKSPACE_IPC.handle("debug.magicLamp", (params) => ({
  runs: magicLampDebug(
    (params as { durationMs?: number | null } | undefined)?.durationMs,
  ),
  // plasmashell's windows and the layer-shell surfaces.
  shell: [...PLASMA_SHELL_WINDOWS.values()].map((window) => ({
    id: window.id,
    role: window.plasma.peek()?.role,
    rect: window.rect,
  })),
  layers: Object.values(COMPOSITOR.layer.current).map((layer) => ({
    namespace: layer.namespace,
    layer: layer.layer,
    position: layer.position,
  })),
  // Each window's taskbar entry, as plasmashell sent it.
  taskbarEntries: Object.fromEntries(
    HYBRID_WINDOW_MANAGER.listWindows().map((window) => [
      window.id,
      window.minimizedGeometry?.peek() ?? null,
    ]),
  ),
}));

// ---------------------------------------------------------------------------
// Dock proximity: watch the pointer and broadcast enter/leave for the bottom
// strip of each monitor. The bar uses this in place of a layer-shell trigger
// surface (which would otherwise capture clicks meant for the windows below).
// ---------------------------------------------------------------------------
// Two thresholds with hysteresis:
//   - SHOW: pointer must be in the bottom 10px to trigger reveal
//   - HIDE: once visible, pointer must leave the bottom 120px to dismiss
// This gives a precise "reach for the dock" trigger while keeping the dock
// stable once the user is interacting with it (so brushing the cursor a few
// dozen pixels above the dock body does not flicker it away).
const DOCK_SHOW_ZONE_PX = 10;
const DOCK_HIDE_ZONE_PX = 120;
const dockProximityByMonitor = new Map<string, boolean>();

function pointerInBottomStrip(
  monitor: string,
  pointerX: number,
  pointerY: number,
  stripPx: number,
): boolean {
  const output = COMPOSITOR.output.get(monitor);
  if (!output || !output.resolution) {
    return false;
  }
  const width = output.resolution.width / output.scale;
  const height = output.resolution.height / output.scale;
  const left = output.position.x;
  const top = output.position.y;
  const right = left + width;
  const bottom = top + height;
  return (
    pointerX >= left &&
    pointerX < right &&
    pointerY >= bottom - stripPx &&
    pointerY < bottom
  );
}

function nextDockProximity(
  monitor: string,
  pointerX: number,
  pointerY: number,
  onTrackedMonitor: boolean,
): boolean {
  if (!onTrackedMonitor) return false;
  const wasInside = dockProximityByMonitor.get(monitor) === true;
  // While outside, only the narrow show-zone counts (10px).
  // While inside, the wide hide-zone keeps it open (120px).
  return pointerInBottomStrip(
    monitor,
    pointerX,
    pointerY,
    wasInside ? DOCK_HIDE_ZONE_PX : DOCK_SHOW_ZONE_PX,
  );
}

function updateDockProximity(monitor: string, inside: boolean) {
  if (dockProximityByMonitor.get(monitor) === inside) {
    return;
  }
  dockProximityByMonitor.set(monitor, inside);
  WORKSPACE_IPC.broadcast("dock.proximity", { monitor, inside });
}

// Snap-zone preview: broadcast the active snap rect (floating edge zones, or the
// opened tiling slot) to the bar, which renders the rounded preview overlay.
//   snap.preview  { monitor, rect: {x,y,w,h} | null, kind: "floating"|"tiling" }
let lastSnapJson = "";
HYBRID_WINDOW_MANAGER.setSnapPreviewBroadcaster((preview) => {
  const json = JSON.stringify(preview);
  if (json === lastSnapJson) {
    return;
  }
  lastSnapJson = json;
  WORKSPACE_IPC.broadcast("snap.preview", preview);
});

HYBRID_WINDOW_MANAGER.setWorkspaceChangeBroadcaster(() => {
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.onDisable(() => {
  WORKSPACE_IPC.close();
});

COMPOSITOR.process.once("fcitx5", {
  command: "fcitx5 -d",
  runPolicy: "once-per-session",
});

// The preview runs inside KDE, which sets KDE_FULL_SESSION. A real ShojiWM
// login does not. Inside KDE, the KDE desktop already runs, so the preview
// must not start a second one.
const INSIDE_KDE =
  (
    globalThis as {
      Deno?: { env: { get(key: string): string | undefined } };
    }
  ).Deno?.env.get("KDE_FULL_SESSION") === "true";

/**
 * The environment of the KDE services. The session says "ShojiWM"; KDE wants
 * to know it runs KDE. XDG_MENU_PREFIX: Kickoff reads its app list from
 * plasma-applications.menu. KDE_FULL_SESSION and KDE_SESSION_VERSION: KDE
 * libraries only apply KDE behaviour (like panel-coloured tray icons) in a
 * full KDE session.
 */
const KDE_SERVICE_ENV = {
  XDG_CURRENT_DESKTOP: "KDE",
  XDG_MENU_PREFIX: "plasma-",
  KDE_FULL_SESSION: "true",
  KDE_SESSION_VERSION: "6",
};

if (!INSIDE_KDE) {
  // KDE's shortcut service. In KDE, KWin gives it a Wayland backend; here it
  // runs on its X11 backend. plasmashell needs it to give Kickoff a
  // shortcut, and without one `activateLauncherMenu` (Super) does nothing.
  COMPOSITOR.process.service("kglobalaccel", {
    command: [
      "env",
      "-u",
      "WAYLAND_DISPLAY",
      "KGLOBALACCELD_PLATFORM=xcb",
      "QT_QPA_PLATFORM=xcb",
      "XDG_SESSION_TYPE=x11",
      "/usr/lib/kglobalacceld",
    ],
    // The same KDE environment as plasmashell. Both keep KDE's app database
    // (~/.cache/ksycoca6_*). With a different menu prefix or desktop name,
    // each found the other's copy wrong and rebuilt it, 20 times a second:
    // plasmashell sat at 85% CPU and this service at 40%.
    env: KDE_SERVICE_ENV,
    restart: "on-exit",
  });
  // The KDE desktop: your taskbar, start menu, icons, tray and wallpaper.
  // It waits up to 3 s for the shortcut service, then starts. Errors go to
  // ~/.local/state/plasmashell.log.
  COMPOSITOR.process.service("plasmashell", {
    command: [
      "sh",
      "-c",
      'for i in 1 2 3 4 5 6; do qdbus6 org.kde.kglobalaccel >/dev/null 2>&1 && break; sleep 0.5; done; exec plasmashell --no-respawn 2>>"$HOME/.local/state/plasmashell.log"',
    ],
    env: KDE_SERVICE_ENV,
    restart: "on-exit",
  });
  // Owns KWin's Window View D-Bus name, so the taskbar shows a group's
  // windows side by side instead of a text list (see the helper's header).
  COMPOSITOR.process.service("window-view-dbus", {
    command: [
      "sh",
      "-c",
      'exec python3 "$HOME/.config/shojiwm/src/helpers/window-view-dbus.py" "$1"',
      "window-view-dbus",
      defaultSocketPath(),
    ],
    restart: "on-exit",
  });
  // Owns KWin's screenshot D-Bus name, so Spectacle (Print Screen) works:
  // on Wayland it can only capture through KWin (see the helper's header).
  COMPOSITOR.process.service("screenshot-dbus", {
    command: [
      "sh",
      "-c",
      'exec python3 "$HOME/.config/shojiwm/src/helpers/screenshot-dbus.py" "$1"',
      "screenshot-dbus",
      defaultSocketPath(),
    ],
    restart: "on-exit",
  });
  // Owns KWin's session D-Bus object, so Plasma's Log Out, Restart and
  // Shut Down work: they ask KWin to end the session (see the helper).
  COMPOSITOR.process.service("session-dbus", {
    command: [
      "sh",
      "-c",
      'exec python3 "$HOME/.config/shojiwm/src/helpers/session-dbus.py"',
    ],
    restart: "on-exit",
  });
  // The KDE window that asks for your password when an app needs admin rights.
  COMPOSITOR.process.service("polkit-agent", {
    command: ["/usr/lib/polkit-kde-authentication-agent-1"],
    restart: "on-exit",
  });
}
// Reads the Global Theme the user picked and sends "theme.set" (see the
// helper's header and `TITLEBAR_STYLE`).
COMPOSITOR.process.service("theme-watch", {
  command: [
    "sh",
    "-c",
    'exec python3 "$HOME/.config/shojiwm/src/helpers/theme-watch.py" "$1"',
    "theme-watch",
    defaultSocketPath(),
  ],
  restart: "on-exit",
});
// Draws the Coverflow switcher's title (see the helper's header).
COMPOSITOR.process.service("switcher-label", {
  command: [
    "sh",
    "-c",
    'exec python3 "$HOME/.config/shojiwm/src/helpers/switcher-label.py" "$1"',
    "switcher-label",
    defaultSocketPath(),
  ],
  restart: "on-exit",
});
// Draws the keyboard cheat sheet on Super+/ (see the helper's header).
COMPOSITOR.process.service("key-sheet", {
  command: [
    "sh",
    "-c",
    'exec python3 "$HOME/.config/shojiwm/src/helpers/key-sheet.py" "$1"',
    "key-sheet",
    defaultSocketPath(),
  ],
  restart: "on-exit",
});
// cliphist clipboard history watchers. Text and image need separate watchers;
// run as services so they are restarted if they ever exit.
COMPOSITOR.process.service("cliphist-text", {
  command: ["wl-paste", "--type", "text", "--watch", "cliphist", "store"],
  restart: "on-exit",
});
COMPOSITOR.process.service("cliphist-image", {
  command: ["wl-paste", "--type", "image", "--watch", "cliphist", "store"],
  restart: "on-exit",
});

// The preview has no KDE desktop of its own, so it shows your KDE wallpaper
// with swaybg (from ShojiWM's .localdeps folder).
if (INSIDE_KDE) {
  COMPOSITOR.process.service("wallpaper", {
    command: [
      "/home/abhishek/Downloads/work/ShojiWM/.localdeps/usr/bin/swaybg",
      "--mode",
      "fill",
      "--image",
      "/home/abhishek/Pictures/lionel-messi-barcelona-priceless_pxl1zxyenorn1eq99f1emz5iw.jpg",
    ],
    restart: "on-exit",
  });
}

// Your KDE start menu (Kickoff), like the Windows key on KDE.
// plasmashell's `activateLauncherMenu` does nothing outside KWin, so this
// fires Kickoff's own shortcut ("activate widget <id>") in kglobalaccel. If
// plasmashell lost the shortcut (it does when it starts before kglobalaccel),
// the script gives Kickoff its Alt+F1 back first.
// The launcher on the panel: Kickoff (Mac look) or SevenStart (Aero look).
const KICKOFF_ID_SCRIPT =
  'panels().forEach(function (p) { ["org.kde.plasma.kickoff", "io.gitgud.wackyideas.SevenStart"].forEach(function (plugin) { p.widgets(plugin).forEach(function (w) { if (!w.globalShortcut) { w.globalShortcut = "Alt+F1"; } print(w.id + "\\n"); }); }); });';
function toggleLauncher() {
  COMPOSITOR.process.spawn({
    command: [
      "sh",
      "-c",
      'id=$(qdbus6 org.kde.plasmashell /PlasmaShell evaluateScript "$1" | head -n 1) && [ -n "$id" ] && qdbus6 org.kde.kglobalaccel /component/plasmashell org.kde.kglobalaccel.Component.invokeShortcut "activate widget $id"',
      "toggle-launcher",
      KICKOFF_ID_SCRIPT,
    ],
  });
}
// Lock the screen with hyprlock (config in ~/.config/hypr/hyprlock.conf).
// `pidof` stops a second lock screen from starting on top of the first.
const LOCK_COMMAND = "pidof hyprlock || hyprlock";

// Lock before the PC goes to sleep. No idle timeout: the screen never
// locks or sleeps by itself. `loginctl lock-session` (and the KDE "Lock"
// button) also land here.
if (!INSIDE_KDE) {
  COMPOSITOR.process.service("auto-lock", {
    command: [
      "swayidle",
      "-w",
      "before-sleep",
      LOCK_COMMAND,
      "lock",
      LOCK_COMMAND,
    ],
    restart: "on-exit",
  });
}

// Every key binding is in one table (./keymap.ts). The cheat sheet
// (Super+/, ./helpers/key-sheet.py) and `shoji-keys` read the same table.
const KEYMAP = createKeymap({
  windowManager: HYBRID_WINDOW_MANAGER,
  switcher: WINDOW_SWITCHER,
  grid: WINDOW_GRID,
  windowView: WINDOW_VIEW,
  switcherOpen: () => SWITCHERS.blurSuspended.peek(),
  broadcastWorkspaces: () => scheduleWorkspaceBroadcast(),
  toggleLauncher,
  toggleKeySheet: () => WORKSPACE_IPC.broadcast("keys.sheet", { toggle: true }),
  lockCommand: LOCK_COMMAND,
  insideKde: INSIDE_KDE,
});
bindKeymap(KEYMAP);
const KEYMAP_ROWS = keymapRows(KEYMAP);
writeKeymapFile(KEYMAP_ROWS);
WORKSPACE_IPC.handle("keys.list", () => ({ rows: KEYMAP_ROWS }));
// Debug (tests over IPC): run a chord's action, as if the key went down.
WORKSPACE_IPC.handle("debug.key", (params) => {
  const { keys } = (params ?? {}) as { keys?: string };
  return typeof keys === "string" && runChord(KEYMAP, keys);
});

// The animation benchmark (shojiwm-setup/bin/anim-bench). Between "start"
// and "stop" a poll runs once per frame of the output and keeps the time
// between presented frames. Nothing runs when no benchmark is on.
let benchPoll: PollHandle | null = null;
let benchFrames: number[] = [];
WORKSPACE_IPC.handle("debug.bench", (params) => {
  const { action, output, on, level } = (params ?? {}) as {
    action?: "start" | "stop" | "profile" | "quality";
    output?: string;
    on?: boolean;
    level?: number;
  };
  if (action === "start") {
    benchPoll?.cancel();
    benchFrames = [];
    let lastMs: number | null = null;
    benchPoll = createPoll(
      1,
      (handle) => {
        if (lastMs !== null) {
          benchFrames.push(Math.round((handle.nowMs - lastMs) * 100) / 100);
        }
        lastMs = handle.nowMs;
      },
      { output: output ?? "DP-2", dirty: "none" },
    );
    return { started: true };
  }
  if (action === "stop") {
    benchPoll?.cancel();
    benchPoll = null;
    const frames = benchFrames;
    benchFrames = [];
    return { frames, quality: qualityDebug() };
  }
  if (action === "quality" && typeof level === "number") {
    setQualityLevel(level);
    return qualityDebug();
  }
  if (action === "profile") {
    COMPOSITOR.debug.enableProfile(Boolean(on));
    return { profile: COMPOSITOR.debug.profile };
  }
  return null;
});

COMPOSITOR.output.configure((context) => {
  const display: DisplayConfigDraft = {};

  display["eDP-1"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.8,
    transform: "normal",
    hdr: false,
  };
  display["eDP-2"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.8,
    hdr: false,
  };
  display["HDMI-A-1"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.5,
  };
  display["DP-1"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.5,
  };
  display["DP-4"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.5,
  };
  // Abhishek's monitor, same as his KDE display settings.
  display["DP-2"] = {
    mode: "extend",
    resolution: { width: 2560, height: 1440, refreshRate: 144 },
    position: "auto",
    scale: 1,
  };

  const isDocked = context.connected.some(
    (output) => output.name === "HDMI-A-1",
  );
  if (isDocked) {
    display["eDP-1"] = { mode: "disabled" };
    display["eDP-2"] = { mode: "disabled" };
  }

  return display;
});

COMPOSITOR.input.configure((input, _context) => {
  input.global = {
    touchpad: {
      tapToClick: true,
      naturalScroll: true,
      scrollMethod: "twoFinger",
      disableWhileTyping: true,
      scrollFactor: 0.3,
    },
    // KDE defaults, like Abhishek's KDE session: normal mouse acceleration,
    // Caps Lock stays Caps Lock, KDE's key repeat timing.
    pointer: {
      accelProfile: "adaptive",
      motionSpace: "logical",
    },
    keyboard: {
      layout: "us",
      repeatRate: 25,
      repeatDelay: 600,
    },
  };
});

HYBRID_WINDOW_MANAGER.configureWorkspaceGestureSpeed({
  workspaceScrollFactor: 1.5,
  workspaceScrollKineticFactor: 1,
  workspaceSwitchFactor: 1,
  workspaceSwitchVelocityFactor: 1,
  // At or below this scroll speed (logical px/s) the workspace scroll
  // catches on tile snap positions (fully-on-screen edges; center for
  // maximized tiles). 0 disables snapping.
  workspaceScrollSnapMaxVelocity: 600,
  // Finger travel (logical px) needed to break out of a caught position.
  workspaceScrollSnapBreakoutPx: 48,
});

// Blur behind the regions clients ask for (ext-background-effect). Off while
// the window switcher is shown, then faded back in like the window backdrops.
const BACKGROUND_BLUR = compileEffect({
  input: backdropSource(),
  capturePadding: 24,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  alpha: "preserve",
  pipeline: [dualKawaseBlur({ radius: 4, passes: 2 }), backdropFade()],
});
COMPOSITOR.effect.background_effect = computed(() =>
  GLASS_PAUSED() ? null : BACKGROUND_BLUR,
);

// Glass behind the title bars and the terminals, compiled once and shared by
// every window. Dark Aero glass or macOS liquid glass (`TITLEBAR_STYLE`).
const liquidGlassStage = () =>
  shaderStage(loadShader("./src/effect/liquid-glass.frag"), {
    uniforms: {
      // Follow the window's rounded corners.
      glass_radius_px: -1.0,
      distortion_depth: 0.2,
      distortion_strength: 0.15,
      chromatic_shift_px: 3.0,
      glass_tint: 0.9,
    },
  });
const TERMINAL_SHADER = compileEffect({
  input: backdropSource(),
  capturePadding: 24,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  pipeline: [dualKawaseBlur({ radius: 4, passes: 2 }), liquidGlassStage(), backdropFade()],
  alpha: "preserve",
});
const MAC_TITLE_SHADER = compileEffect({
  input: backdropSource(),
  capturePadding: 24,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  alpha: "preserve",
  pipeline: [dualKawaseBlur({ radius: 4, passes: 2 }), liquidGlassStage(), backdropFade()],
});
// Radius 4 like the other glass: under the dark tint, 6 looked the same and
// cost more.
const AERO_TITLE_SHADER = compileEffect({
  input: backdropSource(),
  capturePadding: 24,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  alpha: "preserve",
  pipeline: [
    dualKawaseBlur({ radius: 4, passes: 2 }),
    shaderStage(loadShader("./src/effect/aero-glass.frag"), {
      uniforms: {
        darkness: 0.62,
        gloss_strength: 0.09,
        streak_strength: 0.05,
      },
    }),
    backdropFade(),
  ],
});

const LAYER_BLUR_MASK = compileLayerEffect({
  input: backdropSource(),
  capturePadding: 24,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  // The mask stage intentionally outputs transparency (the blur is clipped
  // to the layer's own alpha), so the pipeline's alpha must survive the
  // finish/display passes instead of being forced opaque.
  alpha: "preserve",
  pipeline: [
    dualKawaseBlur({ radius: 4, passes: 2 }),
    shaderStage(loadShader("./src/effect/layer-blur-mask.frag"), {
      textures: {
        layer_mask: layerSource(),
      },
      uniforms: {
        opacity_threshold: 0.25,
        mask_feather: 0.04,
      },
    }),
  ],
});

// Jelly drag (like KDE's Wobbly Windows) while a window moves.
// Set to false to turn it off. It shows only in a real session, not in the
// preview inside KDE.
const JELLY_DRAG = true;
// Magic Lamp (KDE's minimize effect, ./magic-lamp.ts): a minimizing window
// pours into its taskbar entry. It wins over the jelly drag while it runs.
configureMagicLamp({ panels: () => panelRects() });
// With the KDE desktop (plasmashell's panel), tiles split the screen evenly
// like KDE. Without it, ShojiWM's own tile width stays.
configureEvenTileSplit(() => plasmaShellWindows("panel").length > 0);
// The popups slide out of these panels too (KWin's sliding popups).
configureSlidingPopups({ panels: () => panelRects() });

/**
 * KWin's "docks": plasma panels (windows or layer-shell surfaces) and any
 * other bar, in global logical px.
 */
function panelRects() {
  return [
    ...plasmaShellWindows("panel").map((window) => ({
      x: window.rect.x,
      y: window.rect.y,
      width: window.rect.width,
      height: window.rect.height,
    })),
    ...Object.values(COMPOSITOR.layer.current)
      .filter((layer) => layer.layer !== "background")
      .flatMap((layer) => {
        const output = COMPOSITOR.output.get(layer.outputName);
        if (!output) {
          return [];
        }
        // Layer positions are output-local.
        return [
          {
            x: output.position.x + layer.position.x,
            y: output.position.y + layer.position.y,
            width: layer.position.width,
            height: layer.position.height,
          },
        ];
      }),
  ];
}
COMPOSITOR.effect.window = (window) =>
  magicLampEffect(window) ?? (JELLY_DRAG ? jellyDragEffect(window) : null);

COMPOSITOR.effect.layer = (layer) => {
  // No layer blur (the panel, popups) while the glass is paused.
  if (GLASS_PAUSED()) {
    return {};
  }
  const namespace = layer.namespace();
  // Both the LiquidIsland experiment and shoji-bar-3 draw only a translucent
  // silhouette and let the compositor recover the shape from its alpha.
  if (namespace === "liquid-island-qs" || namespace === "shoji-bar-3") {
    return { behind: ISLAND_GLASS };
  }
  if (namespace === "no_blur" || namespace === "wallpaper") {
    return {};
  }

  return {
    behind: LAYER_BLUR_MASK,
  };
};

const POPUP_BLUR = compilePopupEffect({
  input: backdropSource(),
  capturePadding: 4 * 2 * 2 + 24 + 32,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  // The mask stage intentionally outputs transparency (the blur is clipped
  // to the layer's own alpha), so the pipeline's alpha must survive the
  // finish/display passes instead of being forced opaque.
  alpha: "preserve",
  pipeline: [
    dualKawaseBlur({ radius: 4, passes: 2 }),
    shaderStage(loadShader("./src/effect/layer-blur-mask.frag"), {
      textures: {
        layer_mask: popupSource(),
      },
      uniforms: {
        opacity_threshold: 0.25,
        mask_feather: 0.04,
      },
    }),
  ],
});

COMPOSITOR.effect.popup = (popup) => {
  if (popup.parentKind === "window") {
    return {};
  }

  return {
    behind: POPUP_BLUR,
  };
};

// Chromium-family clients repaint their CSD shadow margins as transparent
// black — while still declaring the whole surface opaque — the moment they
// send set_minimized, assuming the surface will never be shown again. Honoring
// that declaration skips blending and paints the margins as a solid black
// ring during the minimize animation.
const isChromiumFamily = (appId: string): boolean => {
  const id = appId.toLowerCase();
  return (
    id.includes("chrome") || id.includes("chromium") || id.includes("electron")
  );
};

// GTK3 tooltips (waybar) declare their whole rect opaque despite transparent
// rounded corners, which paints the corners as a solid fill and culls the
// behind-blur. Ignore the declaration for layer-shell popups.
COMPOSITOR.rendering.surfacePolicy = (surface) => {
  if (surface.kind === "popup" && surface.parentKind === "layer") {
    return { opaqueRegion: "ignore" };
  }
  if (surface.kind === "toplevel") {
    const window = surface.window;
    // Minimized only: the restore animation fades in from opacity 0, so the
    // few frames where a stale black-margin buffer could still be on screen
    // after unminimize are effectively invisible.
    if (
      isChromiumFamily(window.appId() ?? "") &&
      (window.state[WINDOW_STATE_MINIMIZED]() ||
        window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE]())
    ) {
      return { opaqueRegion: "ignore" };
    }
  }
  return null;
};

// plasmashell's own windows skip the window manager in every handler
// below (see `isPlasmaShellWindow`).
COMPOSITOR.event.onOpen((window) => {
  if (isPlasmaShellWindow(window)) {
    noteFocusDebug({
      kind: "shell-open",
      ...focusDebugName(window),
      x: window.plasma.peek()?.x,
      y: window.plasma.peek()?.y,
      takesFocus: plasmaShellWindowTakesFocus(window),
    });
    PLASMA_SHELL_WINDOWS.set(window.id, window);
    if (plasmaShellWindowTakesFocus(window)) {
      window.focus();
    }
    return;
  }
  HYBRID_WINDOW_MANAGER.onOpen(window);
});

COMPOSITOR.event.onInitialConfigure((window) => {
  if (isPlasmaShellWindow(window)) {
    return;
  }
  HYBRID_WINDOW_MANAGER.onInitialConfigure(window);
});

/** plasmashell popups that slide out of their panel (KWin's sliding popups). */
function slidesFromPanel(window: WaylandWindow): boolean {
  const plasma = window.plasma.peek();
  // Kickoff, the calendar, the tray popups, and the taskbar's grouped-window
  // list (a positioned "normal" window).
  return plasma?.role === "appletpopup" || plasma?.role === "normal";
}

COMPOSITOR.event.onFirstCommit((window) => {
  if (isPlasmaShellWindow(window)) {
    if (slidesFromPanel(window)) {
      slidePopupIn(window);
    }
    return;
  }
  HYBRID_WINDOW_MANAGER.onFirstCommit(window);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onStartClose((window) => {
  if (isPlasmaShellWindow(window)) {
    if (slidesFromPanel(window)) {
      slidePopupOut(window);
    }
    return;
  }
  HYBRID_WINDOW_MANAGER.onStartClose(window);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onClose((window) => {
  if (isPlasmaShellWindow(window)) {
    noteFocusDebug({ kind: "shell-close", ...focusDebugName(window) });
  }
  PLASMA_SHELL_WINDOWS.delete(window.id);
  if (isPlasmaShellWindow(window)) {
    // A focused popup can close before it reports the focus loss.
    FOCUSED_SHELL_WINDOWS.delete(window.id);
    syncPointerFocusPause();
    return;
  }
  HYBRID_WINDOW_MANAGER.onClose(window);
  jellyDragForget(window);
  magicLampForget(window);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onFocus((window, focused) => {
  noteFocusDebug({ kind: "focus", focused, ...focusDebugName(window) });
  if (isPlasmaShellWindow(window)) {
    // plasmashell closes Kickoff when it loses focus. Do not let the
    // pointer move focus to a tiled window while a shell popup has it.
    if (focused) {
      FOCUSED_SHELL_WINDOWS.add(window.id);
    } else {
      FOCUSED_SHELL_WINDOWS.delete(window.id);
    }
    syncPointerFocusPause();
    return;
  }
  HYBRID_WINDOW_MANAGER.onFocus(window, focused);
  if (focused) {
    HYBRID_WINDOW_MANAGER.recordFocus(window.id);
    scheduleWorkspaceBroadcast();
  }
});

let lastPointerTargetKey = "";
COMPOSITOR.event.onPointerMove((event) => {
  const targetKey =
    event.target.kind === "window"
      ? `window:${event.target.windowId}`
      : event.target.kind === "layer"
        ? `layer:${event.target.layerId}`
        : "none";
  if (targetKey !== lastPointerTargetKey) {
    lastPointerTargetKey = targetKey;
    noteFocusDebug({
      kind: "pointer-target",
      target: targetKey,
      x: Math.round(event.position.x),
      y: Math.round(event.position.y),
    });
  }
  HYBRID_WINDOW_MANAGER.onPointerMove(event);

  // Dock proximity: update only the monitor the pointer is currently on,
  // and emit "leave" for other monitors that were previously inside. The
  // narrow/wide threshold is hysteretic per current state.
  const pointerX = event.position.x;
  const pointerY = event.position.y;
  for (const monitor of COMPOSITOR.output.list) {
    const inside = nextDockProximity(
      monitor,
      pointerX,
      pointerY,
      monitor === event.outputName,
    );
    updateDockProximity(monitor, inside);
  }
});

COMPOSITOR.event.onGestureSwipe((event) => {
  HYBRID_WINDOW_MANAGER.onGestureSwipe(event);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onOutputChange((event) => {
  HYBRID_WINDOW_MANAGER.onOutputChange(event);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onCreateLayer(() => {
  HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onUpdateLayer(() => {
  HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onDestroyLayer(() => {
  HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onWindowResize((event) => {
  if (isPlasmaShellWindow(event.window)) {
    return;
  }
  HYBRID_WINDOW_MANAGER.onWindowResize(event);
});

COMPOSITOR.pointer.bindWindowMoveModifier("Super");
COMPOSITOR.pointer.bindWindowResizeModifier("Super");
COMPOSITOR.cursor.bindAppLockIgnoreModifier("Super");

COMPOSITOR.event.onWindowMove((event) => {
  if (isPlasmaShellWindow(event.window)) {
    return;
  }
  // A dragged-out Chrome tab moves as a miniature (see tabDragMoveEvent).
  const moveEvent = HYBRID_WINDOW_MANAGER.tabDragMoveEvent(event);
  HYBRID_WINDOW_MANAGER.onWindowMove(moveEvent);
  jellyDragOnWindowMove(moveEvent);
});

COMPOSITOR.event.onWindowMaximizeRequest((event) => {
  if (isPlasmaShellWindow(event.window)) {
    return;
  }
  HYBRID_WINDOW_MANAGER.onWindowMaximizeRequest(event);
});

COMPOSITOR.event.onWindowMinimizeRequest((event) => {
  if (isPlasmaShellWindow(event.window)) {
    return;
  }
  HYBRID_WINDOW_MANAGER.onWindowMinimizeRequest(event);
  // The Pager's desktops carry which windows are minimized.
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onWindowFullscreenRequest((event) => {
  if (isPlasmaShellWindow(event.window)) {
    return;
  }
  HYBRID_WINDOW_MANAGER.onWindowFullscreenRequest(event);
});

COMPOSITOR.event.onWindowActivateRequest((event) => {
  if (isPlasmaShellWindow(event.window)) {
    event.window.focus();
    return;
  }
  HYBRID_WINDOW_MANAGER.onWindowActivateRequest(event);
  scheduleWorkspaceBroadcast();
});

// Must match the frame the composition below draws: a client-decorated window
// gets only the border, so counting the title bar would size its client 30px
// past what the layout meant (and past the client's own maximum).
function naturalRootRect(window: WaylandWindow): ManagedWindowRect {
  const client = window.position;
  const titlebar = usesClientDecoration(window.decoration.peek())
    ? 0
    : TITLEBAR_HEIGHT;
  return {
    x: client.x - WINDOW_BORDER_PX,
    y: client.y - titlebar - WINDOW_BORDER_PX,
    width: client.width + WINDOW_BORDER_PX * 2,
    height: client.height + titlebar + WINDOW_BORDER_PX * 2,
  };
}

// Stack order of plasmashell's windows: the desktop under everything, the
// rest above every normal window (even a fullscreen one, as in KWin).
const PLASMA_Z_INDEX: Record<PlasmaSurfaceRole, number> = {
  // A positioned "normal" window: the taskbar's grouped-window list.
  normal: 2_100_000_000,
  desktop: -2_100_000_000,
  panel: 2_050_000_000,
  appletpopup: 2_100_000_000,
  notification: 2_110_000_000,
  onscreendisplay: 2_110_000_000,
  criticalnotification: 2_120_000_000,
  tooltip: 2_130_000_000,
};

// KWin draws a soft shadow under plasmashell's popups (plasmashell asks for
// it through org_kde_kwin_shadow, which ShojiWM does not speak). This is a
// close copy: Breeze's popup corner radius and a dark, wide, soft shadow.
// The panel and the desktop get none, as in KWin.
const PLASMA_POPUP_RADIUS = 8;
/** Behind see-through windows while the glass blur is off (opaque). */
const WINDOW_SOLID_BACKDROP = "#1b1e24";
const PLASMA_POPUP_SHADOW = [{ y: 6, blur: 28, spread: 0, color: "#000000a0" }];

/** Blur behind the Aero taskbar (see `plasmaShellComposition`). */
const AERO_PANEL_GLASS = compileEffect({
  input: backdropSource(),
  capturePadding: 24,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  alpha: "preserve",
  pipeline: [dualKawaseBlur({ radius: 6, passes: 2 }), backdropFade()],
});

/**
 * Blur behind plasmashell's popups on the Aero look (the start menu,
 * notifications, tray popups, OSDs, tooltips). Under KWin plasmashell asks
 * for it with KDE's blur protocol, which ShojiWM does not speak; the popups
 * are rounded rects, so the blur is clipped to one.
 */
const AERO_POPUP_RADIUS = 6;
const AERO_POPUP_GLASS = compileEffect({
  input: backdropSource(),
  capturePadding: 24,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  alpha: "preserve",
  pipeline: [
    dualKawaseBlur({ radius: 6, passes: 2 }),
    shaderStage(loadShader("./src/effect/rounded-mask.frag"), {
      uniforms: { radius_px: AERO_POPUP_RADIUS },
    }),
  ],
});

/**
 * Glass behind plasmashell's panel and popups. Not `GLASS_PAUSED`: that turns
 * on for every window animation, and a tooltip sliding in is one. Each flip
 * built the panel and every popup again, with and then without the blur, so
 * the taskbar flickered on every hover. Only the look and a machine that is
 * too slow switch it.
 */
const AERO_SHELL_GLASS = computed(() => TITLEBAR_STYLE() === "aero" && !qualityLight());

/**
 * Popups that get no blur: a tooltip comes and goes as the pointer crosses
 * the taskbar, too fast for a blur pass to keep up with its size.
 */
const UNBLURRED_POPUP_ROLES = new Set(["tooltip"]);

/** A plasmashell window: the client surface where plasmashell asked. */
function plasmaShellComposition(
  window: WaylandWindow,
  plasma: PlasmaSurfaceState,
) {
  const rect = computed(() => {
    // Read the position here, not in the composition: a tooltip that moves
    // (from one taskbar icon to the next) then only moves; it is not built
    // again, which made it flicker.
    const live = window.plasma() ?? plasma;
    return {
      // Before plasmashell sends a position, keep the window where it is.
      x: live.x ?? window.position.x,
      y: live.y ?? window.position.y,
      width: window.position.width,
      height: window.position.height,
    };
  });
  const zIndex = PLASMA_Z_INDEX[plasma.role];
  // Aero: the taskbar is smoky glass, so blur what is behind it. KWin's
  // blur effect does this for AeroThemePlasma; the panel picture only tints.
  if (plasma.role === "panel" && AERO_SHELL_GLASS()) {
    return (
      <ManagedWindow rect={rect} zIndex={zIndex}>
        <ShaderEffect shader={AERO_PANEL_GLASS} direction="column">
          <ClientWindow />
        </ShaderEffect>
      </ManagedWindow>
    );
  }
  if (plasma.role === "panel" || plasma.role === "desktop") {
    return (
      <ManagedWindow rect={rect} zIndex={zIndex}>
        <ClientWindow />
      </ManagedWindow>
    );
  }
  const aeroGlass = AERO_SHELL_GLASS() && !UNBLURRED_POPUP_ROLES.has(plasma.role);
  return (
    <ManagedWindow rect={rect} zIndex={zIndex}>
      <WindowBorder
        style={{
          border: { px: 0, color: "#00000000" },
          borderRadius: aeroGlass ? AERO_POPUP_RADIUS : PLASMA_POPUP_RADIUS,
          boxShadow: PLASMA_POPUP_SHADOW,
          background: "#00000000",
          padding: 0,
        }}
      >
        {aeroGlass ? (
          <ShaderEffect shader={AERO_POPUP_GLASS} direction="column">
            <ClientWindow />
          </ShaderEffect>
        ) : (
          <ClientWindow />
        )}
      </WindowBorder>
    </ManagedWindow>
  );
}

/** App ids whose last part does not read as the app's name. */
const APP_NAMES: Record<string, string> = {
  code: "VS Code",
  "google-chrome": "Chrome",
  "com.obsproject.studio": "OBS Studio",
  obs: "OBS Studio",
};

/**
 * The title bar shows the app's name, not the window title:
 * "org.kde.konsole" -> "Konsole", "code" -> "VS Code". A window with no
 * app id keeps its title.
 */
function appName(appId: string | null | undefined, title: string): string {
  if (!appId) {
    return title;
  }
  const known = APP_NAMES[appId.toLowerCase()];
  if (known) {
    return known;
  }
  const last = appId.split(".").pop() || appId;
  return last
    .split(/[-_]/)
    .filter((word) => word.length > 0)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** The client draws its own title bar (CSD), so ours is not drawn. */
function usesClientDecoration(decoration: WindowDecorationState): boolean {
  return (
    decoration.mode === "client" &&
    !(
      decoration.clientPreference === "server" &&
      decoration.configuredMode === "server"
    )
  );
}

COMPOSITOR.window.composition = (window: WaylandWindow) => {
  // A plasmashell window stays one: read it without subscribing, so its
  // moves do not build the composition again. Other windows subscribe, in
  // case the plasma role or position comes after the first composition.
  let plasma = window.plasma.peek();
  if (!plasma || !isPlasmaShellSurface(plasma)) {
    plasma = window.plasma();
  }
  if (plasma && isPlasmaShellSurface(plasma)) {
    return plasmaShellComposition(window, plasma);
  }

  const useClientDecoration = usesClientDecoration(window.decoration());
  const workspaceVisible = window.state[WINDOW_STATE_WORKSPACE_VISIBLE];
  const workspaceOffsetX = window.state[WINDOW_STATE_WORKSPACE_OFFSET_X];
  const workspaceOpacity = window.state[WINDOW_STATE_WORKSPACE_OPACITY];
  const tileDragging = window.state[WINDOW_STATE_TILE_DRAGGING];
  const managedRect = computed(() => {
    const rect = window.state[WINDOW_STATE_RECT]();
    return {
      // Workspaces sit in one row: a switch slides them sideways.
      x: read(rect.x) + workspaceOffsetX(),
      y: read(rect.y),
      width: read(rect.width),
      height: read(rect.height),
    };
  });
  // A tab Chrome drags out shows as a live miniature (see
  // WINDOW_STATE_TAB_DRAG_SCALE): scaled from its top-left corner.
  const tabDragTransform = computed(() => {
    const scale = window.state[WINDOW_STATE_TAB_DRAG_SCALE]() ?? 1;
    return { origin: { x: 0, y: 0 }, scale };
  });
  const forceRectSize = computed(() => {
    // Read the signals so this updates when they change.
    window.isResizable();
    window.isTransient();
    window.appId();
    return isTileable(window);
  });

  // force no corner rounding CSD
  const tiled = true;

  const zIndex = computed(() => windowZIndex(window));
  const minimizeVisualIdle = window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE];
  const inactive = computed(
    () => minimizeVisualIdle() || (!workspaceVisible() && !tileDragging()),
  );
  // A window in the Magic Lamp stays drawn (and stacked) until the lamp
  // ends, though it takes no input.
  const idle = computed(
    () => inactive() && !(magicLampRunning(window) && workspaceVisible()),
  );

  const borderColor = window.isFocused((focused) =>
    // A clear white line marks the focused window; the others keep a faint one.
    focused ? "#FFFFFF73" : "#FFFFFF14",
  );
  // A soft drop shadow under the frame; the focused window floats a bit higher.
  // The window selected in the grid or the Window View glows white instead
  // (it fits in the switcher's texture margin). Alt+Tab's Coverflow puts
  // its front card on a glass panel (`switcherPanel`) instead of the glow.
  // No shadows when the machine is too slow for them. They stay on through
  // animations: switching them re-sent every window at each start and end.
  // Most of the way onto Coverflow's glass panel, the card drops its own
  // shadow: the panel draws one around itself.
  const onPanel = computed(() => (WINDOW_SWITCHER.panels().get(window.id)?.strength ?? 0) > 0.5);
  const windowShadow = computed(() =>
    qualityLight() || onPanel()
      ? []
      : glowsSelected(window)
        ? [{ blur: 28, spread: 4, color: "#ffffffd0" }]
        : window.isFocused()
          ? [{ y: 10, blur: 32, spread: -2, color: "#00000090" }]
          : [{ y: 4, blur: 16, spread: -2, color: "#00000060" }],
  );
  // With the glass blur on, the title bar is see-through glass. With it off
  // (an animation runs, a switcher is open, or the GPU is too busy), a
  // see-through bar would show sharp text from behind, so it turns solid.
  const titlebarBackground = computed(() =>
    TITLEBAR_STYLE() === "aero"
      ? GLASS_PAUSED()
        ? window.isFocused()
          ? "#14171df2"
          : "#1e2128f2"
        : window.isFocused()
          ? "#00000000"
          : "#ffffff0d"
      : GLASS_PAUSED()
        ? window.isFocused()
          ? "#1f2430f2"
          : "#2a2f3af2"
        : window.isFocused()
          ? "#1f243080"
          : "#2a2f3a80",
  );
  const titleColor = window.isFocused((focused) =>
    focused ? "#f5f7fa" : "#c9d1d9",
  );

  const titlebarStyle: SSDStyle = {
    height: TITLEBAR_HEIGHT,
    paddingX: TITLEBAR_PADDING_X,
    gap: TITLEBAR_GAP,
    alignItems: "center",
    background: titlebarBackground,
  };

  const titleOnlyShader =
    TITLEBAR_STYLE() === "aero" ? AERO_TITLE_SHADER : MAC_TITLE_SHADER;
  // No backdrop effects while the window switcher shows the windows as
  // textures: there is nothing under a window there to blur.
  const blurSuspended = GLASS_PAUSED();

  const appIcon = (
    <AppIcon icon={window.icon} style={{ width: 16, height: 16 }} />
  );
  const label = (
    <Label
      text={computed(() => appName(window.appId(), window.title()))}
      style={{
        color: titleColor,
        fontFamily: ["Noto Sans CJK JP", "Noto Color Emoji"],
        fontSize: 13,
        fontWeight: 600,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
      }}
    />
  );
  const minimizeButton = <MinimizeButton window={window} />;
  const maximizeButton = <MaximizeButton window={window} />;
  const closeButton = <CloseButton window={window} />;

  // The buttons on the right, in the KDE order: minimize, maximize, close.
  // In the Window View only the hovered card shows them.
  const titlebarContent = !trafficLightsShown(window)
    ? [appIcon, label]
    : usesAeroStrip(TITLEBAR_STYLE())
      ? [appIcon, label, <AeroCaptionButtons window={window} />]
      : [
          appIcon,
          label,
          <Box
            direction="row"
            style={{ gap: TRAFFIC_LIGHT_GAP, alignItems: "center", flexShrink: 0 }}
          >
            {minimizeButton}
            {maximizeButton}
            {closeButton}
          </Box>,
        ];
  // Apps like Konsole and Dolphin draw a see-through background and ask for
  // blur behind it. Without the blur, a flat dark backdrop goes behind them
  // instead, so the text behind the window never shows through. One flat
  // fill: no GPU cost to speak of.
  var innerComponents = (
    <Box
      direction="column"
      style={blurSuspended ? { background: WINDOW_SOLID_BACKDROP } : {}}
    >
      {blurSuspended ? (
        <Box direction="row" style={titlebarStyle}>
          {titlebarContent}
        </Box>
      ) : (
        <ShaderEffect
          shader={titleOnlyShader}
          direction="row"
          style={titlebarStyle}
        >
          {titlebarContent}
        </ShaderEffect>
      )}
      <ClientWindow />
    </Box>
  );

  const TERMINALS = ["kitty", "ghostty"];

  if (TERMINALS.includes(window.appId() ?? "")) {
    const terminalContent = [
      <Box direction="row" style={titlebarStyle}>
        {titlebarContent}
      </Box>,
      <ClientWindow />,
    ];
    innerComponents = blurSuspended ? (
      <Box direction="column">{terminalContent}</Box>
    ) : (
      <ShaderEffect shader={TERMINAL_SHADER} direction="column">
        {terminalContent}
      </ShaderEffect>
    );
  }

  // Fullscreen: drop all chrome (titlebar, border, rounded corners) and let
  // the client surface fill its managed rect edge to edge. The rect is set to
  // the whole output by onWindowFullscreenRequest. Rendering nothing but the
  // bare ClientWindow is also what lets the tty backend promote the client
  // buffer to the primary plane (direct scanout).
  if (window.state[WINDOW_STATE_FULLSCREEN]()) {
    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={FULLSCREEN_Z_INDEX}
        visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
        opacity={workspaceOpacity}
        forceRectSize={forceRectSize}
        transform={tabDragTransform}
        tiled={tiled}
        idle={idle}
        interactive={inactive((value) => !value)}
        // Permit low-latency tearing for fullscreen windows. The compositor only actually tears
        // once the window is on the direct-scanout fast path and is committing faster than the
        // refresh rate (i.e. games), so this is a no-op for ordinary fullscreen apps. Narrow it
        // per app if desired, e.g. `allowTearing={isGame(window.appId())}`.
        allowTearing={true}
      >
        <ClientWindow />
      </ManagedWindow>
    );
  }

  // use less Server-Side Decoration
  if (useClientDecoration) {
    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={zIndex}
        visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
        opacity={workspaceOpacity}
        forceRectSize={forceRectSize}
        transform={tabDragTransform}
        tiled={tiled}
        idle={idle}
        interactive={inactive((value) => !value)}
      >
        <WindowBorder
          paint={switcherPanel(window)}
          style={{
            border: { px: WINDOW_BORDER_PX, color: borderColor },
            borderRadius: 10,
            boxShadow: windowShadow,
            background: "#10131900",
            padding: 0,
            paddingX: 0,
            paddingRight: 0,
          }}
          interaction={{
            resizeHitArea: {
              edgePx: 8,
              cornerPx: 14,
            },
          }}
        >
          <ClientWindow />
        </WindowBorder>
      </ManagedWindow>
    );
  }

  // use full Server-Side Decoration
  return (
    <ManagedWindow
      rect={managedRect}
      zIndex={zIndex}
      visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
      opacity={workspaceOpacity}
      forceRectSize={forceRectSize}
      transform={tabDragTransform}
      tiled={tiled}
      idle={idle}
      interactive={inactive((value) => !value)}
    >
      <WindowBorder
        paint={switcherPanel(window)}
        style={{
          border: { px: WINDOW_BORDER_PX, color: borderColor },
          borderRadius: 10,
          boxShadow: windowShadow,
          background: "#10131900",
          padding: 0,
          paddingX: 0,
          paddingRight: 0,
        }}
        interaction={{
          resizeHitArea: {
            edgePx: 8,
            cornerPx: 14,
          },
        }}
      >
        <Box direction="row">{innerComponents}</Box>
      </WindowBorder>
    </ManagedWindow>
  );
};

/**
 * The look of the title bars:
 * - "aero": dark Windows 7 Aero glass, with the buttons `AERO_CAPTION` picks.
 * - "mac": macOS 27 glass traffic lights (see `TrafficLight`).
 *
 * The user picks it as a KDE Global Theme (or with the shoji-theme script);
 * ./helpers/theme-watch.py reads the choice and sends "theme.set".
 */
type TitlebarStyle = "aero" | "mac";
const TITLEBAR_STYLE = signal<TitlebarStyle>("aero");

/**
 * The buttons on the Aero title bar: "mac-lights" are the macOS 27 glass
 * traffic lights (`TrafficLight`), "aero-strip" Windows 7's joined strip
 * (`AeroCaptionButtons`).
 */
const AERO_CAPTION = "mac-lights" as "mac-lights" | "aero-strip";

/** The title bar shows Windows 7's joined strip of buttons. */
const usesAeroStrip = (style: TitlebarStyle) =>
  style === "aero" && AERO_CAPTION === "aero-strip";
WORKSPACE_IPC.handle("theme.set", (params) => {
  const style = (params as { titlebar?: unknown } | undefined)?.titlebar;
  if ((style === "aero" || style === "mac") && TITLEBAR_STYLE.peek() !== style) {
    TITLEBAR_STYLE.value = style;
  }
});

/**
 * The Aero buttons' finish (see `assets/aero-buttons.py`): "glass" is
 * Windows 7's gloss with a see-through colour tint on hover; "flat" is
 * solid fills with a crisp border.
 */
const AERO_BUTTON_FINISH = "glass" as "flat" | "glass";

/** What a title bar's maximize button does. A window that cannot resize stays. */
function toggleMaximize(window: WaylandWindow) {
  if (!read(window.isResizable)) {
    return;
  }
  if (read(window.isMaximized)) {
    window.unmaximize();
  } else {
    window.maximize();
  }
}

// macOS-style traffic lights. Unfocused windows show grey lights, as on macOS.
// macOS 27 draws 14 pt lights 23 pt apart, but a Mac screen has more pixels
// per point than this 1x screen, so 16 px with a 10 px gap matches what the
// eye sees on the Mac (the same size-to-pitch ratio: 23 / 14 ≈ 26 / 16).
const TRAFFIC_LIGHT_SIZE = 16;
/** Space between two traffic lights. */
const TRAFFIC_LIGHT_GAP = 10;
/** The title bar's padding left and right, and the space between its items. */
const TITLEBAR_PADDING_X = 8;
const TITLEBAR_GAP = 8;

/**
 * The window glows white: the selected card of a switcher, unless Alt+Tab
 * is Coverflow, which draws a glass panel instead (`switcherPanel`).
 */
const glowsSelected = (window: WaylandWindow) =>
  SWITCHERS.selectedWindowId() === window.id &&
  !(WINDOW_SWITCHER_STYLE === "coverflow" && WINDOW_SWITCHER.selectedWindowId() === window.id);

/**
 * The Windows 7 thumbnail card behind Coverflow's front window: a white
 * glass panel, drawn around the window border (./effect/switcher-panel.frag).
 * The switcher drives its strength every frame, so it fades and moves with
 * the card. At strength 0 the shader draws only the built-in border.
 */
function switcherPanel(window: WaylandWindow) {
  const panel = computed(() => WINDOW_SWITCHER.panels().get(window.id));
  return paintShader("./src/effect/switcher-panel.frag", {
    uniforms: {
      strength: computed(() => panel()?.strength ?? 0),
      unit: computed(() => panel()?.unit ?? 1),
    },
    // The card's texture holds this much room around the window.
    outsets: SWITCHER_MARGIN,
  });
}

/** The window is the hovered card of the Window View or the grid, or Alt+Tab's selected card. */
const isWindowViewCard = (window: WaylandWindow) =>
  WINDOW_VIEW.selectedWindowId() === window.id ||
  WINDOW_GRID.selectedWindowId() === window.id ||
  WINDOW_SWITCHER.selectedWindowId() === window.id;

/** While a switcher is open, only its hovered or selected card shows traffic lights. */
const trafficLightsShown = (window: WaylandWindow) =>
  (!WINDOW_VIEW.isOpen() && !WINDOW_GRID.isOpen() && !WINDOW_SWITCHER.isOpen()) ||
  isWindowViewCard(window);

/**
 * The traffic light at `(x, y)`, logical px from the top-left corner of
 * `window.rect` (the frame: border, then our title bar). Each light takes
 * the whole title bar height and half the gap on both sides, so a
 * scaled-down card still has a usable target.
 */
function titlebarButtonAt(window: WaylandWindow, x: number, y: number): TitlebarButton | null {
  if (
    window.plasma.peek() ||
    window.state[WINDOW_STATE_FULLSCREEN].peek() ||
    usesClientDecoration(window.decoration.peek())
  ) {
    return null;
  }
  if (y < WINDOW_BORDER_PX || y > WINDOW_BORDER_PX + TITLEBAR_HEIGHT) {
    return null;
  }
  // From the right: close, maximize, minimize.
  const buttons: TitlebarButton[] = ["close", "maximize", "minimize"];
  const right = window.rect.width - WINDOW_BORDER_PX - TITLEBAR_PADDING_X;
  if (usesAeroStrip(TITLEBAR_STYLE.peek())) {
    // The strip hangs from the top of the title bar; a little slack below
    // it for a scaled-down card.
    if (y > WINDOW_BORDER_PX + AERO_BUTTON_HEIGHT + 4) {
      return null;
    }
    let edge = right;
    for (const button of buttons) {
      const left = edge - AERO_BUTTON_WIDTH[button];
      if (x >= left && x <= edge) {
        return button;
      }
      edge = left;
    }
    return null;
  }
  const pitch = TRAFFIC_LIGHT_SIZE + TRAFFIC_LIGHT_GAP;
  for (let i = 0; i < buttons.length; i++) {
    const center = right - TRAFFIC_LIGHT_SIZE / 2 - i * pitch;
    if (Math.abs(x - center) <= pitch / 2) {
      return buttons[i];
    }
  }
  return null;
}
/**
 * macOS 27 glass lights: a saturated body, a lighter glow in its lower half
 * and thin bright rims, drawn from SVGs (see `assets/mac-glass-*.svg`).
 * Unfocused windows show grey glass.
 */
const TRAFFIC_LIGHT_BODIES = {
  close: "./assets/mac-glass-close.svg",
  minimize: "./assets/mac-glass-minimize.svg",
  maximize: "./assets/mac-glass-maximize.svg",
  inactive: "./assets/mac-glass-inactive.svg",
};

/**
 * A light grows under the pointer. A press pushes it in like the start orb:
 * down to 90% at once, held at least TRAFFIC_LIGHT_PRESS_HOLD_MS, then it
 * springs back up. The values add to a scale of 1.
 */
const TRAFFIC_LIGHT_HOVER_GROW = 0.2;
const TRAFFIC_LIGHT_PRESS_GROW = -0.1;
const TRAFFIC_LIGHT_PRESS_MS = 60;
const TRAFFIC_LIGHT_PRESS_HOLD_MS = 100;
const TRAFFIC_LIGHT_GROW_MS = 200;
/** The hover starts and stops softly (an ease-out jumps on its first frame). */
const TRAFFIC_LIGHT_HOVER_EASING = cubicBezier(0.4, 0, 0.2, 1);
const TRAFFIC_LIGHT_SPRING_MS = 220;
/** Overshoots a little before it settles: the macOS 27 bounce. */
const TRAFFIC_LIGHT_SPRING = cubicBezier(0.34, 1.56, 0.64, 1);
const TRAFFIC_LIGHT_GROW = {
  close: animationVariable("trafficLightGrow.close"),
  minimize: animationVariable("trafficLightGrow.minimize"),
  maximize: animationVariable("trafficLightGrow.maximize"),
};

// The Window View's hovered card shows colour, like a focused window.
const trafficLightBody = (window: WaylandWindow, body: string) =>
  computed(() =>
    window.isFocused() || isWindowViewCard(window)
      ? body
      : TRAFFIC_LIGHT_BODIES.inactive,
  );

/**
 * One traffic light: the glass body, a click target over it, and a glyph
 * while the pointer is on it. Hover and press grow the whole light from its
 * centre.
 */
const TrafficLight = ({
  window,
  kind,
  body,
  glyph,
  enabled,
  onClick,
}: {
  window: WaylandWindow;
  kind: keyof typeof TRAFFIC_LIGHT_GROW;
  body: string | ReadonlySignal<string>;
  glyph: string | ReadonlySignal<string>;
  enabled: () => boolean;
  onClick: () => void;
}) => {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const grow = TRAFFIC_LIGHT_GROW[kind];
  let pressedAt = 0;

  const animateGrow = () => {
    if (read(pressed) && enabled()) {
      // Pushed in.
      window.animation.start(grow, {
        duration: TRAFFIC_LIGHT_PRESS_MS,
        to: TRAFFIC_LIGHT_PRESS_GROW,
        easing: TRAFFIC_LIGHT_HOVER_EASING,
      });
      return;
    }
    const target = enabled() && read(hover) ? TRAFFIC_LIGHT_HOVER_GROW : 0;
    // Coming back up from a press springs; a plain hover eases.
    const spring = window.animation.variable(grow).peek() < 0;
    window.animation.start(grow, {
      duration: spring ? TRAFFIC_LIGHT_SPRING_MS : TRAFFIC_LIGHT_GROW_MS,
      to: target,
      easing: spring ? TRAFFIC_LIGHT_SPRING : TRAFFIC_LIGHT_HOVER_EASING,
    });
  };

  return (
    <Box
      style={{
        position: "relative",
        flexShrink: 0,
        width: TRAFFIC_LIGHT_SIZE,
        height: TRAFFIC_LIGHT_SIZE,
        transform: { scale: window.animation.variable(grow)((value) => 1 + value) },
      }}
    >
      <Image
        src={body}
        style={{
          width: TRAFFIC_LIGHT_SIZE,
          height: TRAFFIC_LIGHT_SIZE,
          position: "absolute",
          pointerEvents: "none",
        }}
      />
      <Button
        onHoverChange={(value) => {
          setHover(value);
          if (!value) {
            setPressed(false);
          }
          animateGrow();
        }}
        onActiveChange={(value) => {
          setPressed(value);
          if (value) {
            pressedAt = Date.now();
            animateGrow();
            return;
          }
          // A quick click still shows the press before it springs back.
          const wait = TRAFFIC_LIGHT_PRESS_HOLD_MS - (Date.now() - pressedAt);
          if (wait > 0) {
            setTimeout(animateGrow, wait);
          } else {
            animateGrow();
          }
        }}
        style={{
          width: TRAFFIC_LIGHT_SIZE,
          height: TRAFFIC_LIGHT_SIZE,
          borderRadius: TRAFFIC_LIGHT_SIZE / 2,
        }}
        onClick={onClick}
      />
      {hover() && enabled() ? (
        <Image
          src={glyph}
          style={{
            width: TRAFFIC_LIGHT_SIZE,
            height: TRAFFIC_LIGHT_SIZE,
            position: "absolute",
            zIndex: 1,
            pointerEvents: "none",
          }}
        />
      ) : null}
    </Box>
  );
};

const CloseButton = ({ window }: { window: WaylandWindow }) => (
  <TrafficLight
    window={window}
    kind="close"
    body={trafficLightBody(window, TRAFFIC_LIGHT_BODIES.close)}
    glyph="./assets/mac-glass-x.svg"
    enabled={() => true}
    onClick={window.close}
  />
);


const MaximizeButton = ({ window }: { window: WaylandWindow }) => {
  // A window that cannot resize gets a grey light, like on macOS.
  const body = computed(() =>
    window.isResizable() && (window.isFocused() || isWindowViewCard(window))
      ? TRAFFIC_LIGHT_BODIES.maximize
      : TRAFFIC_LIGHT_BODIES.inactive,
  );
  // macOS's full screen glyph: triangles out to maximize, in to restore.
  const glyph = window.isMaximized((maximized) =>
    maximized ? "./assets/mac-glass-shrink.svg" : "./assets/mac-glass-expand.svg",
  );

  return (
    <TrafficLight
      window={window}
      kind="maximize"
      body={body}
      glyph={glyph}
      enabled={() => read(window.isResizable)}
      onClick={() => toggleMaximize(window)}
    />
  );
};

const MinimizeButton = ({ window }: { window: WaylandWindow }) => (
  <TrafficLight
    window={window}
    kind="minimize"
    body={trafficLightBody(window, TRAFFIC_LIGHT_BODIES.minimize)}
    glyph="./assets/mac-glass-minus.svg"
    enabled={() => true}
    onClick={() => window.minimize()}
  />
);

/**
 * Dark Aero caption buttons: Windows 7's joined strip at the top right
 * (minimize and maximize 29x19, close 48x19). At rest they are dark and
 * neutral; under the pointer they turn yellow, green or red, fading in over
 * 0.1 s and out over 0.3 s, as on Windows 7. Pressed is a darker shade.
 * The SVGs come from `assets/aero-buttons.py`.
 */
const AERO_BUTTON_HEIGHT = 19;
const AERO_BUTTON_WIDTH: Record<TitlebarButton, number> = {
  minimize: 29,
  maximize: 29,
  close: 48,
};
/** The glass tint comes in this many drawn steps (`TINT_STEPS` in the generator). */
const AERO_TINT_STEPS = 4;
const AERO_GLOW_IN_MS = 100;
const AERO_GLOW_OUT_MS = 300;
const AERO_GLOW = {
  close: animationVariable("aeroGlow.close"),
  minimize: animationVariable("aeroGlow.minimize"),
  maximize: animationVariable("aeroGlow.maximize"),
};

const AeroButton = ({
  window,
  kind,
  glyph,
  enabled,
  onClick,
}: {
  window: WaylandWindow;
  kind: TitlebarButton;
  glyph: string | ReadonlySignal<string>;
  enabled: () => boolean;
  onClick: () => void;
}) => {
  const [pressed, setPressed] = useState(false);
  const width = AERO_BUTTON_WIDTH[kind];
  const size = { width, height: AERO_BUTTON_HEIGHT };
  const glow = AERO_GLOW[kind];
  const lit = computed(() => window.isFocused() || isWindowViewCard(window));
  // ShojiWM draws an image at full strength, so the fade is not an opacity:
  // the button steps through drawn tints, from faint to full (see
  // `assets/aero-buttons.py`). Neutral at rest; the colour shows under the
  // pointer; pressing shows a stronger one.
  const asset = `./assets/aero-${AERO_BUTTON_FINISH}-${kind}`;
  const tint = window.animation.variable(glow);
  const body = computed(() => {
    if (!lit() || !enabled()) {
      return `${asset}-inactive.svg`;
    }
    if (pressed()) {
      return `${asset}-press.svg`;
    }
    const level = tint();
    if (AERO_BUTTON_FINISH === "flat") {
      return level > 0.5 ? `${asset}-hover.svg` : `${asset}-rest.svg`;
    }
    const step = Math.ceil(level * AERO_TINT_STEPS - 0.01);
    return step > 0 ? `${asset}-tint${step}.svg` : `${asset}-rest.svg`;
  });

  const fade = (on: boolean) => {
    const show = on && enabled();
    window.animation.start(glow, {
      duration: show ? AERO_GLOW_IN_MS : AERO_GLOW_OUT_MS,
      to: show ? 1 : 0,
      easing: linear,
    });
  };

  return (
    <Box style={{ position: "relative", flexShrink: 0, ...size }}>
      <Image src={body} style={{ ...size, position: "absolute", pointerEvents: "none" }} />
      <Button
        onHoverChange={(value) => {
          if (!value) {
            setPressed(false);
          }
          fade(value);
        }}
        onActiveChange={(value) => setPressed(value && enabled())}
        style={size}
        onClick={onClick}
      />
      <Image
        src={computed(() => {
          const path = read(glyph);
          // Unfocused or disabled: the dimmer glyph.
          return lit() && enabled() ? path : path.replace(/\.svg$/, "-dim.svg");
        })}
        style={{ ...size, position: "absolute", zIndex: 1, pointerEvents: "none" }}
      />
    </Box>
  );
};

/** The joined strip, hung from the top of the title bar. */
const AeroCaptionButtons = ({ window }: { window: WaylandWindow }) => (
  <Box style={{ height: TITLEBAR_HEIGHT, alignItems: "start", flexShrink: 0 }}>
    <Box direction="row">
      <AeroButton
        window={window}
        kind="minimize"
        glyph={`./assets/aero-${AERO_BUTTON_FINISH}-glyph-minimize.svg`}
        enabled={() => true}
        onClick={() => window.minimize()}
      />
      <AeroButton
        window={window}
        kind="maximize"
        glyph={window.isMaximized((maximized) =>
          maximized ? `./assets/aero-${AERO_BUTTON_FINISH}-glyph-restore.svg` : `./assets/aero-${AERO_BUTTON_FINISH}-glyph-maximize.svg`,
        )}
        enabled={() => read(window.isResizable)}
        onClick={() => toggleMaximize(window)}
      />
      <AeroButton
        window={window}
        kind="close"
        glyph={`./assets/aero-${AERO_BUTTON_FINISH}-glyph-close.svg`}
        enabled={() => true}
        onClick={window.close}
      />
    </Box>
  </Box>
);

export default COMPOSITOR;
