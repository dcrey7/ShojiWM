/**
 * The launcher (Super): a glass pop-up in the middle of the screen with a
 * search pill, 2 rows of recommended apps, 3 rows of pinned apps, the
 * account and the 5 power lights. Typing turns the grid into results.
 *
 * The design is the approved mock
 * (shojiwm-setup/docs/research/launcher-mockup/launcher.html); the sizes are
 * in ./launcher-model.ts, together with the logic.
 *
 * How it is drawn: the output composition cannot draw text or blur, a window
 * decoration can. ./helpers/launcher-host.py keeps one empty 1x1 window
 * (app id "shoji-launcher") mapped all the time, and this module decorates it
 * with the whole launcher. Opening only makes it visible: nothing starts, so
 * the panel is on screen in the next frame. While it is open, an input grab
 * takes the keys and the pointer, and this module does its own hit testing
 * (every element sits at a position the model computed).
 *
 *   Super ──> open(): host visible, grab keys + pointer, "launcher.home"
 *   a key ──> query edited ──"launcher.query" {id, q}──> shoji-find
 *                                                          │
 *   results drawn <──"launcher.results" {id, sections}─────┘
 *
 * Until shoji-find answers, a small app list built in here fills the grid
 * and typing filters it by name, so the launcher never looks empty.
 */
import {
  Box,
  ClientWindow,
  COMPOSITOR,
  Image,
  Label,
  ManagedWindow,
  ShaderEffect,
  animationVariable,
  backdropSource,
  compileEffect,
  computed,
  createPoll,
  cubicBezier,
  dualKawaseBlur,
  loadShader,
  outputLogicalSize,
  paintShader,
  shaderStage,
  signal,
  type AnimationVariable,
  type CompositionRenderable,
  type InputGrab,
  type InputGrabKeyEvent,
  type InputGrabPointerButtonEvent,
  type InputGrabPointerMotionEvent,
  type InputGrabScrollEvent,
  type PollHandle,
  type ReadonlySignal,
  type WaylandWindow,
} from "shoji_wm";
import type { IpcServer } from "shoji_wm/ipc";
import {
  ACCOUNT,
  BODY,
  CONTENT_WIDTH,
  CONTENT_X,
  FIRST_LIGHT_X,
  HEADER_LINE,
  HEADER_X,
  LIGHT_BUTTON,
  LIGHT_PITCH,
  lightIcon,
  lightSize,
  MAX_RESULT_TILES,
  NOTE_HEIGHT,
  PANEL_HEIGHT,
  PANEL_RADIUS,
  PANEL_WIDTH,
  PILL,
  PILL_HEIGHT,
  POWER_Y,
  ROW,
  SEARCH,
  SEARCH_FONT,
  SEARCH_ICON,
  SEARCH_TEXT_X,
  TILE_HEIGHT,
  TILE_ICON,
  TILE_ICON_TOP,
  TILE_LABEL_HEIGHT,
  TILE_LABEL_TOP,
  TILE_RADIUS,
  TILE_WIDTH,
  bottomEntries,
  editText,
  entryAt,
  fallbackResults,
  font,
  keyChar,
  layoutHome,
  layoutResults,
  mergeResults,
  moveSelection,
  panelRect,
  parseApps,
  parseResults,
  px,
  repeatsDue,
  rowTextTops,
  scrollToShow,
  splitHighlights,
  stripFieldCodes,
  wantsMeaning,
  type Direction,
  type Entry,
  type HomeData,
  type LauncherApp,
  type LauncherItem,
  type LauncherResults,
  type Layout,
  type SectionKind,
  type TextState,
} from "./launcher-model";

/** The app id of ./helpers/launcher-host.py's window. */
export const LAUNCHER_HOST_APP_ID = "shoji-launcher";

// ---------------------------------------------------------------- look

const FONT = ["Noto Sans", "Noto Color Emoji"];
const TEXT = "#e6e9ef";
const MUTED = "#8e96a6";
/** Section titles: the muted grey at 85%. */
const SECTION_COLOR = "#8e96a6d9";
/** Dark Aero glass: #12141a at 82%. */
const GLASS = "#12141ad1";
const RIM = "#ffffff61";
const PANEL_SHADOW = [
  // The small soft white glow of Alt+Tab and the group view.
  { blur: px(12), spread: 2, color: "#fff6e647" },
  { y: px(30), blur: px(80), color: "#000000b3" },
  { blur: 0, spread: 1, color: "#ffffff14", inset: true },
];
/** Selected: a thin light border with a small soft glow outside; nothing inside. */
const SELECTED_BORDER = "#fffaf073";
const SELECTED_GLOW = [{ blur: px(9), spread: 1, color: "#fff6e642" }];
const NO_BORDER = "#00000000";
const HOVER_FILL = "#ffffff0f";
const ACCOUNT_HOVER_FILL = "#ffffff12";
/** The panel sits above every window and plasmashell popup (tooltips: 2_130_000_000). */
const LAUNCHER_Z_INDEX = 2_140_000_000;
const GENERIC_ICON = "/usr/share/icons/breeze-dark/mimetypes/32/application-x-executable.svg";
const WEB_ICON = "/usr/share/icons/hicolor/256x256/apps/google-chrome.png";
const SETTINGS_ICON = "/usr/share/icons/breeze-dark/apps/48/systemsettings.svg";

/** The account: an initial on the blue workspace glass. */
const ACCOUNT_NAME = "Abhishek";
/** The "Pin to Apps" / "Unpin" pill of a right click. */
const CONTEXT_HEIGHT = px(36);
const CONTEXT_WIDTH = px(140);

// ---------------------------------------------------------------- motion

/** Opening and closing: a quick fade with a scale from 0.97. */
const OPEN_MS = 120;
const OPEN_FADE_SHARE = 0.09 / 0.12;
const OPEN_FROM_SCALE = 0.97;
const OPEN_EASING = cubicBezier(0.2, 0.8, 0.2, 1);
const FADE_EASING = cubicBezier(0, 0, 0.58, 1);
/** Hover grows in 200 ms with soft ends (as the traffic lights). */
const HOVER_MS = 200;
const HOVER_EASING = cubicBezier(0.4, 0, 0.2, 1);
/** A tile's icon grows 1.08x under the pointer (the mock's 120 ms). */
const TILE_HOVER_MS = 120;
const TILE_HOVER_EASING = cubicBezier(0.2, 0.8, 0.2, 1);
/** A press pushes in at once, holds at least 100 ms, then springs back. */
const PRESS_IN_MS = 60;
const PRESS_HOLD_MS = 100;
const SPRING_MS = 220;
const SPRING = cubicBezier(0.34, 1.56, 0.64, 1);
const CARET_BLINK_MS = 530;
/** Milliseconds for the speed numbers (`performance` may be missing here). */
const clock = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
/** Images are rasterized at this many times their size (see `SharpImage`). */
const OVERSAMPLE = 2;
/**
 * A held key repeats after this delay, at this rate (then faster). KDE's
 * kcminputrc is empty here, so these are the fallback values.
 */
const REPEAT_DELAY_MS = 250;
const REPEAT_RATE = 30;
/** Keys that repeat while held (typed characters repeat too). */
const REPEATING_KEYS = new Set([
  "Up", "Down", "Left", "Right", "KP_Up", "KP_Down", "KP_Left", "KP_Right",
  "BackSpace", "Delete", "KP_Delete",
]);

// ---------------------------------------------------------------- data

const PAPIRUS = "/home/abhishek/.local/share/icons/Papirus/48x48/apps/";
const HICOLOR = "/usr/share/icons/hicolor/256x256/apps/";
const BREEZE = "/usr/share/icons/breeze-dark/apps/48/";

/** The mock's apps: shown until shoji-find sends the real home data. */
const FALLBACK_APPS: LauncherApp[] = (
  [
    ["Chrome", HICOLOR + "google-chrome.png", "google-chrome"],
    ["Konsole", PAPIRUS + "org.kde.konsole.svg", "org.kde.konsole"],
    ["VS Code", PAPIRUS + "visual-studio-code.svg", "code"],
    ["Dolphin", "/usr/share/icons/hicolor/scalable/apps/org.kde.dolphin.svg", "org.kde.dolphin"],
    ["Discord", PAPIRUS + "discord.svg", "discord"],
    ["Spotify", PAPIRUS + "spotify.svg", "spotify"],
    ["OBS Studio", HICOLOR + "com.obsproject.Studio.png", "com.obsproject.Studio"],
    ["Steam", HICOLOR + "steam.png", "steam"],
    ["Spectacle", "/home/abhishek/.local/share/icons/Uos-fulldistro-icons/apps/64/org.kde.spectacle.svg", "org.kde.spectacle"],
    ["Okular", BREEZE + "org.kde.okular.svg", "org.kde.okular"],
    ["Gwenview", BREEZE + "org.kde.gwenview.svg", "org.kde.gwenview"],
    ["Kate", PAPIRUS + "org.kde.kate.svg", "org.kde.kate"],
    ["WhatsApp", PAPIRUS + "whatsapp.svg", "whatsapp"],
    ["Telegram", PAPIRUS + "telegram.svg", "org.telegram.desktop"],
    ["VLC", HICOLOR + "vlc.png", "vlc"],
    ["Blender", PAPIRUS + "blender.svg", "blender"],
    ["System Settings", BREEZE + "systemsettings.svg", "systemsettings"],
    ["Discover", BREEZE + "plasmadiscover.svg", "org.kde.discover"],
    ["Calculator", PAPIRUS + "org.kde.kcalc.svg", "org.kde.kcalc"],
    ["Ark", BREEZE + "org.kde.ark.svg", "org.kde.ark"],
    ["Writer", HICOLOR + "libreoffice-writer.png", "libreoffice-writer"],
    ["Calc", HICOLOR + "libreoffice-calc.png", "libreoffice-calc"],
    ["Thunderbird", PAPIRUS + "thunderbird.svg", "thunderbird"],
    ["Firefox", HICOLOR + "firefox.png", "firefox"],
    ["GIMP", PAPIRUS + "gimp.svg", "gimp"],
    ["Krita", PAPIRUS + "krita.svg", "org.kde.krita"],
    ["Zoom", PAPIRUS + "Zoom.svg", "Zoom"],
    ["Slack", PAPIRUS + "slack.svg", "slack"],
    ["Elisa", BREEZE + "org.kde.elisa.svg", "org.kde.elisa"],
    ["Kdenlive", BREEZE + "org.kde.kdenlive.svg", "org.kde.kdenlive"],
    ["KDE Connect", PAPIRUS + "kdeconnect.svg", "org.kde.kdeconnect.app"],
    ["Obsidian", PAPIRUS + "obsidian.svg", "obsidian"],
    ["System Monitor", PAPIRUS + "utilities-system-monitor.svg", "org.kde.plasma-systemmonitor"],
    ["Filelight", PAPIRUS + "filelight.svg", "org.kde.filelight"],
    ["Haruna", PAPIRUS + "haruna.svg", "org.kde.haruna"],
    ["KMail", PAPIRUS + "kmail.svg", "org.kde.kmail2"],
    ["Postman", PAPIRUS + "postman.svg", "postman"],
    ["GParted", PAPIRUS + "gparted.svg", "gparted"],
    ["Konversation", BREEZE + "org.kde.konversation.svg", "org.kde.konversation"],
    ["KRDC", BREEZE + "org.kde.krdc.svg", "org.kde.krdc"],
  ] as const
).map(([name, icon, id]) => ({ id: `${id}.desktop`, name, icon, exec: `gtk-launch ${id}` }));

const FALLBACK_HOME: HomeData = {
  recommended: FALLBACK_APPS.slice(0, 16),
  pinned: FALLBACK_APPS.slice(16, 40),
};

/** The power lights, left to right. */
const POWER = [
  { id: "lock", title: "Lock", body: "./assets/launcher-light-yellow.svg", command: ["loginctl", "lock-session"] },
  { id: "sleep", title: "Sleep", body: "./assets/launcher-light-blue.svg", command: ["systemctl", "suspend"] },
  { id: "logout", title: "Log out", body: "./assets/launcher-light-orange.svg", command: ["qdbus6", "org.kde.LogoutPrompt", "/LogoutPrompt", "promptLogout"] },
  { id: "restart", title: "Restart", body: "./assets/launcher-light-green.svg", command: ["qdbus6", "org.kde.LogoutPrompt", "/LogoutPrompt", "promptReboot"] },
  { id: "shutdown", title: "Shut down", body: "./assets/launcher-light-red.svg", command: ["qdbus6", "org.kde.LogoutPrompt", "/LogoutPrompt", "promptShutDown"] },
] as const;
const ACCOUNT_COMMAND = ["systemsettings", "kcm_users"];

/** How long to wait for shoji-find before showing the built-in results. */
const HELPER_WAIT_MS = 60;
/** "searching inside your files..." gives up after this long. */
const MEANING_WAIT_MS = 2500;

// ---------------------------------------------------------------- types

export interface LauncherOptions {
  ipc: IpcServer;
  /** Extra environment for the apps it starts (KDE's, outside KDE). */
  spawnEnv?: Record<string, string>;
  /** Blur behind the panel (off when the machine is too slow). */
  glass: ReadonlySignal<boolean>;
}

export interface Launcher {
  /** The host window's composition, or null for any other window. */
  compose(window: WaylandWindow): CompositionRenderable | null;
  /** Is this the launcher's host window? */
  isHost(window: WaylandWindow): boolean;
  /** `source` "orb": the start orb asked (it pulses by itself). */
  open(source?: string): void;
  close(source?: string): void;
  toggle(source?: string): void;
  readonly isOpen: ReadonlySignal<boolean>;
}

/** A value that animates on the host window (0 at rest). */
interface Anim {
  variable: AnimationVariable;
  value: ReadonlySignal<number>;
  pressedAt: number;
}

/** What the pointer is on. */
type Target =
  | { kind: "entry"; index: number }
  | { kind: "light"; index: number }
  | { kind: "account" }
  | { kind: "context" }
  | { kind: "panel" }
  | { kind: "outside" };

const sameTarget = (a: Target | null, b: Target | null) =>
  !!a && !!b && a.kind === b.kind && ("index" in a ? a.index === (b as { index: number }).index : true);

// ---------------------------------------------------------------- launcher

export function createLauncher(options: LauncherOptions): Launcher {
  const { ipc } = options;
  const [host, setHost] = signal<WaylandWindow | null>(null);
  const [shown, setShown] = signal(false);
  const [isOpen, setIsOpen] = signal(false);
  const [outputRect, setOutputRect] = signal({ name: "", x: 0, y: 0, width: 2560, height: 1440 });
  const [text, setText] = signal<TextState>({ text: "", caret: 0 });
  const [home, setHome] = signal<HomeData>(FALLBACK_HOME);
  const [results, setResults] = signal<LauncherResults | null>(null);
  const [meaningPending, setMeaningPending] = signal(false);
  const [selected, setSelected] = signal(0);
  const [hovered, setHovered] = signal<Target | null>(null);
  const [scroll, setScroll] = signal(0);
  const [caretOn, setCaretOn] = signal(true);
  const [context, setContext] = signal<{ x: number; y: number; app: LauncherApp; pinned: boolean } | null>(null);

  let grab: InputGrab | null = null;
  let queryId = 0;
  let helperAlive = false;
  let helperTimer: ReturnType<typeof setTimeout> | null = null;
  let meaningTimer: ReturnType<typeof setTimeout> | null = null;
  let caretPoll: PollHandle | null = null;
  let pressed: Target | null = null;
  let superDown = false;
  let closing = false;
  /** Debug: record actions instead of running them. */
  let dryRun = false;
  let lastAction: unknown = null;

  const query = computed(() => text().text);
  const typing = computed(() => query().trim().length > 0);
  const layout = computed<Layout>(() =>
    typing() ? layoutResults(results()?.sections ?? [], meaningPending()) : layoutHome(home()),
  );
  const homeLayout = computed(() => layoutHome(home()));
  const resultsLayout = computed(() => layoutResults(results()?.sections ?? [], meaningPending()));

  // ------------------------------------------------------------ animation

  const OPEN = animationVariable("launcher.open");
  const openValue = computed(() => host()?.animation.variable(OPEN)() ?? 0);
  const openOpacity = computed(() => FADE_EASING(Math.min(1, openValue() / OPEN_FADE_SHARE)));
  const openScale = computed(() => OPEN_FROM_SCALE + (1 - OPEN_FROM_SCALE) * OPEN_EASING(openValue()));

  const anim = (name: string): Anim => {
    const variable = animationVariable(name);
    return { variable, value: computed(() => host()?.animation.variable(variable)() ?? 0), pressedAt: 0 };
  };
  const animate = (target: Anim, to: number, duration: number, easing: (t: number) => number) => {
    void host.peek()?.animation.start(target.variable, { to, duration, easing });
  };
  const hoverAnim = (target: Anim | undefined, on: boolean, tile = false) => {
    if (target) {
      animate(target, on ? 1 : 0, tile ? TILE_HOVER_MS : HOVER_MS, tile ? TILE_HOVER_EASING : HOVER_EASING);
    }
  };
  const pressIn = (target: Anim | undefined) => {
    if (!target) {
      return;
    }
    target.pressedAt = Date.now();
    animate(target, 1, PRESS_IN_MS, HOVER_EASING);
  };
  /** Spring back, no sooner than 100 ms after the press. Resolves when it starts. */
  const pressOut = (target: Anim | undefined): Promise<void> => {
    if (!target) {
      return Promise.resolve();
    }
    const wait = Math.max(0, PRESS_HOLD_MS - (Date.now() - target.pressedAt));
    return new Promise((resolve) => {
      setTimeout(() => {
        animate(target, 0, SPRING_MS, SPRING);
        resolve();
      }, wait);
    });
  };

  // ------------------------------------------------------------ slots

  // The tree is built once; every element reads signals, so typing only
  // patches the nodes that changed. Home tiles are fixed slots; results use
  // pools of tiles, rows, pills, titles and notes.
  interface Placed {
    entry: Entry;
    index: number;
  }
  const byKind = (source: ReadonlySignal<Layout>) =>
    computed(() => {
      const tiles: Placed[] = [];
      const rows: Placed[] = [];
      const pills: Placed[] = [];
      source().entries.forEach((entry, index) => {
        (entry.kind === "tile" ? tiles : entry.kind === "row" ? rows : pills).push({ entry, index });
      });
      return { tiles, rows, pills };
    });
  const homeSlots = byKind(homeLayout);
  const resultSlots = byKind(resultsLayout);

  const HOME_TILES = 40;
  const BOTTOM = bottomEntries();
  const RESULT_ROWS = 20;
  const RESULT_PILLS = 2;
  const HEADERS = 8;
  const NOTES = 2;

  interface Slot {
    placed: ReadonlySignal<Placed | undefined>;
    press: Anim;
    hover: Anim;
  }
  const slots = (count: number, name: string, pick: () => Placed[]): Slot[] =>
    Array.from({ length: count }, (_, k) => ({
      placed: computed(() => pick()[k]),
      press: anim(`launcher.${name}.${k}.press`),
      hover: anim(`launcher.${name}.${k}.hover`),
    }));
  const homeTiles = slots(HOME_TILES, "home", () => homeSlots().tiles);
  const resultTiles = slots(MAX_RESULT_TILES, "tile", () => resultSlots().tiles);
  const resultRows = slots(RESULT_ROWS, "row", () => resultSlots().rows);
  const resultPills = slots(RESULT_PILLS, "pill", () => resultSlots().pills);
  const lights = POWER.map((_, k) => ({ press: anim(`launcher.light.${k}.press`), hover: anim(`launcher.light.${k}.hover`) }));
  const account = { press: anim("launcher.account.press"), hover: anim("launcher.account.hover") };

  /** The slot that draws entry `index` of the current layout. */
  const slotOf = (index: number): Slot | undefined => {
    const pools = typing() ? [resultTiles, resultRows, resultPills] : [homeTiles];
    for (const pool of pools) {
      const slot = pool.find((candidate) => candidate.placed.peek()?.index === index);
      if (slot) {
        return slot;
      }
    }
    return undefined;
  };
  const animOf = (target: Target | null): { press?: Anim; hover?: Anim; tile?: boolean } => {
    if (!target) {
      return {};
    }
    switch (target.kind) {
      case "entry": {
        const slot = slotOf(target.index);
        const tile = layout.peek().entries[target.index]?.kind === "tile";
        return { press: slot?.press, hover: tile ? slot?.hover : undefined, tile };
      }
      case "light":
        return lights[target.index];
      case "account":
        return account;
      default:
        return {};
    }
  };

  // ------------------------------------------------------------ IPC

  ipc.handle("launcher.homeData", (params) => {
    const raw = (params ?? {}) as { recommended?: unknown; pinned?: unknown };
    const recommended = parseApps(raw.recommended);
    const pinned = parseApps(raw.pinned);
    if (recommended.length + pinned.length > 0) {
      helperAlive = true;
      setHome({ recommended, pinned });
    }
    return { ok: true };
  });
  ipc.handle("launcher.results", (params) => {
    const incoming = parseResults(params);
    if (!incoming) {
      return { ok: false };
    }
    helperAlive = true;
    if (incoming.id !== queryId) {
      return { ok: true, stale: true };
    }
    if (helperTimer) {
      clearTimeout(helperTimer);
      helperTimer = null;
    }
    // The first reply for this query replaces the built-in results.
    const current = results.peek();
    const merged = mergeResults(current?.id === queryId && !isFallback(current) ? current : null, incoming, queryId);
    setResults(merged);
    if (incoming.sections.some((section) => section.kind === "meaning")) {
      setMeaningPending(false);
    }
    keepSelectionVisible();
    return { ok: true };
  });

  const fallbackIds = new WeakSet<LauncherResults>();
  const isFallback = (value: LauncherResults | null) => !!value && fallbackIds.has(value);
  const allApps = () => {
    const seen = new Set<string>();
    const apps: LauncherApp[] = [];
    for (const app of [...home.peek().recommended, ...home.peek().pinned, ...FALLBACK_APPS]) {
      if (!seen.has(app.name)) {
        seen.add(app.name);
        apps.push(app);
      }
    }
    return apps;
  };
  const showFallback = (id: number) => {
    const value = fallbackResults(allApps(), text.peek().text, id);
    fallbackIds.add(value);
    setResults(value);
  };

  // ------------------------------------------------------------ query

  const setQuery = (next: TextState) => {
    const started = clock();
    setQueryNow(next);
    timing.keyCostMs = Math.round((clock() - started) * 100) / 100;
    measureToFrame(started, "keyToFrameMs");
  };
  const setQueryNow = (next: TextState) => {
    const changed = next.text !== text.peek().text;
    setText(next);
    setCaretOn(true);
    if (!changed) {
      return;
    }
    setSelected(0);
    setScroll(0);
    setContext(null);
    queryId += 1;
    const id = queryId;
    if (helperTimer) {
      clearTimeout(helperTimer);
      helperTimer = null;
    }
    if (meaningTimer) {
      clearTimeout(meaningTimer);
      meaningTimer = null;
    }
    setMeaningPending(false);
    if (!next.text.trim()) {
      setResults(null);
      return;
    }
    ipc.broadcast("launcher.query", { id, q: next.text });
    if (!helperAlive) {
      showFallback(id);
      return;
    }
    // shoji-find answers within a frame or two; if not, show the built-in
    // results and stop waiting for it.
    helperTimer = setTimeout(() => {
      helperTimer = null;
      if (queryId === id && results.peek()?.id !== id) {
        helperAlive = false;
        showFallback(id);
      }
    }, HELPER_WAIT_MS);
    if (wantsMeaning(next.text)) {
      setMeaningPending(true);
      meaningTimer = setTimeout(() => {
        meaningTimer = null;
        if (queryId === id) {
          setMeaningPending(false);
        }
      }, MEANING_WAIT_MS);
    }
  };

  const keepSelectionVisible = () => {
    const current = layout.peek();
    if (selected.peek() >= current.entries.length && current.entries.length > 0 && targetOf(selected.peek())?.kind !== "entry") {
      return; // on the bottom row
    }
    const index = Math.min(selected.peek(), Math.max(0, current.entries.length - 1));
    if (index !== selected.peek()) {
      setSelected(index);
    }
    setScroll(scrollToShow(current.entries[index], scroll.peek(), current.height));
  };

  // ------------------------------------------------------------ actions

  const spawn = (command: string[]) => {
    if (dryRun) {
      lastAction = command;
      return;
    }
    COMPOSITOR.process.spawn({ command, env: options.spawnEnv });
  };

  const runItem = (item: LauncherItem) => {
    const { kind, value } = item.action;
    switch (kind) {
      case "exec":
        spawn(["sh", "-c", stripFieldCodes(value)]);
        ipc.broadcast("launcher.used", { appId: item.id });
        break;
      case "open":
      case "url":
        spawn(["xdg-open", value]);
        break;
      case "copy":
        spawn([
          "sh",
          "-c",
          'if command -v wl-copy >/dev/null; then printf %s "$1" | wl-copy; else qdbus6 org.kde.klipper /klipper org.kde.klipper.klipper.setClipboardContents "$1"; fi',
          "launcher-copy",
          value,
        ]);
        break;
    }
  };

  /** Press `target` in, run what it does when the hold ends, then close. */
  const activate = (target: Target) => {
    const { press } = animOf(target);
    pressIn(press);
    let run: (() => void) | null = null;
    if (target.kind === "entry") {
      const entry = layout.peek().entries[target.index];
      if (entry) {
        run = () => runItem(entry.item);
      }
    } else if (target.kind === "light") {
      const power = POWER[target.index];
      run = () => spawn([...power.command]);
    } else if (target.kind === "account") {
      run = () => spawn(ACCOUNT_COMMAND);
    }
    if (!run) {
      void pressOut(press);
      return;
    }
    // Start the app at once; the panel closes when the press has shown.
    run();
    void pressOut(press).then(() => close());
  };

  const togglePin = (app: LauncherApp, pin: boolean) => {
    const current = home.peek();
    const pinned = pin
      ? current.pinned.some((entry) => entry.id === app.id)
        ? current.pinned
        : [...current.pinned, app]
      : current.pinned.filter((entry) => entry.id !== app.id);
    setHome({ ...current, pinned });
    ipc.broadcast("launcher.pin", { appId: app.id, pinned: pin });
  };

  // ------------------------------------------------------------ input

  /** Panel-local point of a global one. */
  const toPanel = (x: number, y: number) => {
    const rect = panelRect(outputRect.peek());
    return { x: x - rect.x, y: y - rect.y };
  };

  const targetAt = (globalX: number, globalY: number): Target => {
    const { x, y } = toPanel(globalX, globalY);
    const menu = context.peek();
    if (menu && x >= menu.x && x < menu.x + CONTEXT_WIDTH && y >= menu.y && y < menu.y + CONTEXT_HEIGHT) {
      return { kind: "context" };
    }
    if (x < 0 || y < 0 || x >= PANEL_WIDTH || y >= PANEL_HEIGHT) {
      return { kind: "outside" };
    }
    if (x >= BODY.x && x < BODY.x + BODY.width && y >= BODY.y && y < BODY.y + BODY.height) {
      const index = entryAt(layout.peek().entries, x, y - BODY.y + scroll.peek());
      return index >= 0 ? { kind: "entry", index } : { kind: "panel" };
    }
    if (y >= POWER_Y && y < POWER_Y + LIGHT_BUTTON) {
      for (let index = 0; index < POWER.length; index++) {
        const left = FIRST_LIGHT_X + index * LIGHT_PITCH;
        if (x >= left && x < left + LIGHT_BUTTON) {
          return { kind: "light", index };
        }
      }
      if (x >= ACCOUNT.x && x < ACCOUNT.x + ACCOUNT.width && y >= ACCOUNT.y && y < ACCOUNT.y + ACCOUNT.height) {
        return { kind: "account" };
      }
    }
    return { kind: "panel" };
  };

  const setHover = (target: Target | null) => {
    const previous = hovered.peek();
    if (sameTarget(previous, target) || (!previous && !target)) {
      return;
    }
    const before = animOf(previous);
    hoverAnim(before.hover, false, before.tile);
    const after = animOf(target);
    hoverAnim(after.hover, true, after.tile);
    setHovered(target);
    // As in the mock, the pointer selects what it is on.
    if (target?.kind === "entry") {
      setSelected(target.index);
    }
  };

  /**
   * Debug: speed. `cost` is the time the config spends on an open or a key;
   * `toFrame` the time from the call to the start of the next frame (which
   * draws the change): under one refresh period (6.9 ms at 144 Hz) means
   * the change is on screen in the next frame.
   */
  const timing = { openCostMs: 0, openToFrameMs: 0, keyCostMs: 0, keyToFrameMs: 0 };
  const measureToFrame = (start: number, field: "openToFrameMs" | "keyToFrameMs") => {
    const poll = createPoll(
      1,
      (handle) => {
        timing[field] = Math.round((clock() - start) * 100) / 100;
        handle.cancel();
      },
      { output: outputRect.peek().name || "DP-2", dirty: "none" },
    );
    return poll;
  };
  /** Debug: the last opens and closes, and why one was skipped. */
  const events: Record<string, unknown>[] = [];
  const note = (event: Record<string, unknown>) => {
    events.push({ t: Date.now() % 100000, ...event });
    if (events.length > 20) {
      events.shift();
    }
  };
  /** Debug: how many pointer events the grab delivered, and the last point. */
  const inputCounts = { motions: 0, buttons: 0, keys: 0, last: null as { x: number; y: number } | null };

  const onPointerMotion = (event: Pick<InputGrabPointerMotionEvent, "position">) => {
    inputCounts.motions += 1;
    inputCounts.last = { x: Math.round(event.position.x), y: Math.round(event.position.y) };
    if (closing) {
      return;
    }
    setHover(targetAt(event.position.x, event.position.y));
  };

  const onPointerButton = (event: Pick<InputGrabPointerButtonEvent, "position" | "state" | "buttonName">) => {
    inputCounts.buttons += 1;
    if (closing) {
      return;
    }
    const target = targetAt(event.position.x, event.position.y);
    if (event.state === "pressed") {
      if (event.buttonName === "right") {
        if (target.kind === "entry") {
          const entry = layout.peek().entries[target.index];
          const app = entry?.app ?? (entry?.item.action.kind === "exec" ? { id: entry.item.id, name: entry.item.title, icon: entry.item.icon, exec: entry.item.action.value } : undefined);
          if (entry && app) {
            const { x, y } = toPanel(event.position.x, event.position.y);
            const pinned = home.peek().pinned.some((candidate) => candidate.id === app.id);
            setContext({ x: Math.min(x, PANEL_WIDTH - CONTEXT_WIDTH - 10), y, app, pinned });
          }
        }
        return;
      }
      if (event.buttonName !== "left") {
        return;
      }
      if (target.kind === "outside") {
        close();
        return;
      }
      if (target.kind === "context") {
        const menu = context.peek();
        setContext(null);
        if (menu) {
          togglePin(menu.app, !menu.pinned);
        }
        return;
      }
      setContext(null);
      pressed = target;
      pressIn(animOf(target).press);
      return;
    }
    // Released.
    const down = pressed;
    pressed = null;
    if (!down) {
      return;
    }
    if (sameTarget(down, target)) {
      const { press } = animOf(down);
      let run: (() => void) | null = null;
      if (down.kind === "entry") {
        const entry = layout.peek().entries[down.index];
        run = entry ? () => runItem(entry.item) : null;
      } else if (down.kind === "light") {
        const power = POWER[down.index];
        run = () => spawn([...power.command]);
      } else if (down.kind === "account") {
        run = () => spawn(ACCOUNT_COMMAND);
      }
      if (run) {
        run();
        void pressOut(press).then(() => close());
        return;
      }
    }
    void pressOut(animOf(down).press);
  };

  const onScroll = (event: Pick<InputGrabScrollEvent, "deltaY">) => {
    const current = layout.peek();
    const max = Math.max(0, current.height - BODY.height);
    setScroll(Math.max(0, Math.min(max, scroll.peek() + event.deltaY)));
  };

  // ------------------------------------------------------------ key repeat

  /** The key held down, repeating, if any. One poll drives it, per frame. */
  let held: { key: string; modifiers: InputGrabKeyEvent["modifiers"]; downAt: number; repeats: number } | null = null;
  let repeatPoll: PollHandle | null = null;
  const stopRepeat = () => {
    held = null;
    repeatPoll?.cancel();
    repeatPoll = null;
  };
  const startRepeat = (key: string, modifiers: InputGrabKeyEvent["modifiers"]) => {
    stopRepeat();
    held = { key, modifiers, downAt: Date.now(), repeats: 0 };
    repeatPoll = createPoll(
      1,
      () => {
        if (!held || closing || !grab) {
          stopRepeat();
          return;
        }
        const due = repeatsDue(Date.now() - held.downAt, REPEAT_DELAY_MS, REPEAT_RATE);
        // At most a few steps per frame, so a slow frame does not jump far.
        for (let step = 0; held && held.repeats < due && step < 4; step++) {
          held.repeats += 1;
          pressKey(held.key, held.modifiers);
        }
        if (held && held.repeats < due) {
          held.repeats = due;
        }
      },
      { output: outputRect.peek().name, dirty: "none" },
    );
  };

  const onKey = (event: Pick<InputGrabKeyEvent, "key" | "state" | "modifiers">) => {
    inputCounts.keys += 1;
    const { key } = event;
    if (key === "Super_L" || key === "Super_R") {
      if (event.state === "pressed") {
        superDown = true;
      } else if (superDown) {
        superDown = false;
        close();
      }
      return;
    }
    if (event.state === "released") {
      if (held?.key === key) {
        stopRepeat();
      }
      return;
    }
    if (closing) {
      return;
    }
    // The grab sends one press per key: the launcher repeats a held key itself.
    if (REPEATING_KEYS.has(key) || keyChar(key, event.modifiers) !== null) {
      startRepeat(key, event.modifiers);
    }
    pressKey(key, event.modifiers);
  };

  /**
   * What the selection is on: an entry of the grid or the results, or (past
   * the last entry) the bottom row: the account, then the 5 lights.
   */
  const targetOf = (index: number): Target | null => {
    const count = layout.peek().entries.length;
    if (index < count) {
      return count > 0 ? { kind: "entry", index: Math.max(0, index) } : null;
    }
    const bottom = index - count;
    return bottom === 0 ? { kind: "account" } : bottom <= POWER.length ? { kind: "light", index: bottom - 1 } : null;
  };
  const selectedTarget = () => targetOf(selected.peek());

  /** Select by the keyboard: scroll to it, and grow a light or the avatar as on hover. */
  const select = (index: number) => {
    const before = targetOf(selected.peek());
    const after = targetOf(index);
    setSelected(index);
    if (after?.kind === "entry") {
      const current = layout.peek();
      setScroll(scrollToShow(current.entries[after.index], scroll.peek(), current.height));
    }
    if (!sameTarget(before, after)) {
      if (before && before.kind !== "entry" && !sameTarget(before, hovered.peek())) {
        hoverAnim(animOf(before).hover, false);
      }
      if (after && after.kind !== "entry") {
        hoverAnim(animOf(after).hover, true);
      }
    }
  };

  /** One press of a key: what the launcher does with it. */
  const pressKey = (key: string, modifiers: InputGrabKeyEvent["modifiers"]) => {
    switch (key) {
      case "Escape":
        if (context.peek()) {
          setContext(null);
        } else if (text.peek().text) {
          setQuery({ text: "", caret: 0 });
        } else {
          close();
        }
        return;
      case "Return":
      case "KP_Enter": {
        const target = selectedTarget();
        if (target) {
          activate(target);
        }
        return;
      }
      case "Up":
      case "Down":
      case "Left":
      case "Right":
      case "KP_Up":
      case "KP_Down":
      case "KP_Left":
      case "KP_Right": {
        const direction = key.replace("KP_", "") as Direction;
        const current = layout.peek();
        select(moveSelection([...current.entries, ...BOTTOM], selected.peek(), direction));
        return;
      }
      case "Tab":
        return;
    }
    const next = editText(text.peek(), key, modifiers);
    if (next) {
      setQuery(next);
    }
  };

  // ------------------------------------------------------------ open, close

  const outputUnderPointer = () => {
    const cursor = COMPOSITOR.cursor.getPosition();
    const outputs = COMPOSITOR.output.outputs.filter((output) => output.enabled);
    const contains = (output: (typeof outputs)[number]) => {
      if (!cursor) {
        return false;
      }
      const { width, height } = outputLogicalSize(output);
      const { x, y } = output.position;
      return cursor.x >= x && cursor.x < x + width && cursor.y >= y && cursor.y < y + height;
    };
    const output = outputs.find(contains) ?? outputs[0];
    if (!output) {
      return null;
    }
    const { width, height } = outputLogicalSize(output);
    return { name: output.name, x: output.position.x, y: output.position.y, width, height };
  };

  /**
   * The start orb plays its press pulse when the launcher opens or closes
   * (a separate change to the orb plays it when General/orbPulse changes).
   * Fire and forget; one place, to swap for something faster later.
   */
  const pulseOrb = () => {
    if (dryRun) {
      return;
    }
    COMPOSITOR.process.spawn({
      command: [
        "qdbus6",
        "org.kde.plasmashell",
        "/PlasmaShell",
        "org.kde.PlasmaShell.evaluateScript",
        'panels().forEach(function(p){p.widgets("io.gitgud.wackyideas.SevenStart").forEach(function(w){w.currentConfigGroup=["General"];w.writeConfig("orbPulse",String(Date.now()));});});',
      ],
    });
  };

  function open(source?: string) {
    const started = clock();
    const window = host.peek();
    // Opening while it closes takes it back from where the fade is.
    if (!window || (isOpen.peek() && !closing)) {
      note({ open: source ?? "", skipped: window ? "already open" : "no host window" });
      return;
    }
    const output = outputUnderPointer();
    if (!output) {
      note({ open: source ?? "", skipped: "no output" });
      return;
    }
    note({ open: source ?? "", output: output.name });
    closing = false;
    superDown = false;
    pressed = null;
    setOutputRect(output);
    setText({ text: "", caret: 0 });
    setResults(null);
    setSelected(0);
    setScroll(0);
    setContext(null);
    setHovered(null);
    setCaretOn(true);
    setShown(true);
    setIsOpen(true);
    if (source !== "orb") {
      pulseOrb();
    }
    const from = openValue.peek();
    void window.animation.start(OPEN, { from, to: 1, duration: Math.max(1, OPEN_MS * (1 - from)) });
    grab = COMPOSITOR.input.grab({
      onKey,
      onPointerMotion,
      onPointerButton,
      onScroll,
      onCancel: () => {
        grab = null;
        close();
      },
    });
    ipc.broadcast("launcher.home", {});
    timing.openCostMs = Math.round((clock() - started) * 100) / 100;
    measureToFrame(started, "openToFrameMs");
    caretPoll?.cancel();
    caretPoll = createPoll(CARET_BLINK_MS, () => setCaretOn(!caretOn.peek()), { output: output.name, dirty: "none" });
    // The pointer may already be over a tile.
    const cursor = COMPOSITOR.cursor.getPosition();
    if (cursor) {
      const target = targetAt(cursor.x, cursor.y);
      if (target.kind === "entry" || target.kind === "light" || target.kind === "account") {
        setHover(target);
      }
    }
  }

  function close(source?: string) {
    if (!isOpen.peek() || closing) {
      note({ close: source ?? "", skipped: closing ? "closing" : "not open" });
      return;
    }
    note({ close: source ?? "" });
    closing = true;
    stopRepeat();
    if (source !== "orb") {
      pulseOrb();
    }
    grab?.release();
    grab = null;
    caretPoll?.cancel();
    caretPoll = null;
    if (helperTimer) {
      clearTimeout(helperTimer);
      helperTimer = null;
    }
    setHover(null);
    setContext(null);
    const window = host.peek();
    const done = () => {
      if (!closing) {
        return; // opened again meanwhile
      }
      closing = false;
      setShown(false);
      setIsOpen(false);
    };
    if (!window) {
      done();
      return;
    }
    void window.animation
      .start(OPEN, { to: 0, duration: Math.max(1, OPEN_MS * openValue.peek()) })
      .then(done);
  }

  const toggle = (source?: string) => (isOpen.peek() && !closing ? close(source) : open(source));
  // A toggle that comes within 100 ms of the last one is the same click sent
  // twice (the orb's script can send its line twice): drop it.
  let lastIpcToggle = 0;
  ipc.handle("launcher.toggle", (params) => {
    const { source } = (params ?? {}) as { source?: string };
    const now = Date.now();
    if (now - lastIpcToggle < 100) {
      note({ toggle: source ?? "", skipped: "repeat within 100 ms" });
      return { open: isOpen.peek() && !closing };
    }
    lastIpcToggle = now;
    toggle(source);
    return { open: isOpen.peek() && !closing };
  });

  // ------------------------------------------------------------ host window

  const isHost = (window: WaylandWindow) => window.appId.peek() === LAUNCHER_HOST_APP_ID;
  COMPOSITOR.event.onOpen((window) => {
    if (isHost(window)) {
      setHost(window);
    }
  });
  COMPOSITOR.event.onClose((window) => {
    if (host.peek()?.id === window.id) {
      grab?.release();
      grab = null;
      setHost(null);
      setShown(false);
      setIsOpen(false);
    }
  });

  // ------------------------------------------------------------ debug

  ipc.handle("debug.launcher", (params) => {
    const raw = (params ?? {}) as {
      open?: boolean;
      type?: string;
      key?: string;
      shift?: boolean;
      ctrl?: boolean;
      pointer?: { x: number; y: number; button?: "left" | "right"; panel?: boolean };
      scroll?: number;
      hold?: string;
      ms?: number;
      dry?: boolean;
      results?: unknown;
      state?: boolean;
    };
    if (raw.dry !== undefined) {
      dryRun = raw.dry;
    }
    if (raw.open === true) {
      open();
    } else if (raw.open === false) {
      close();
    }
    const modifiers = { super: false, alt: false, ctrl: !!raw.ctrl, shift: !!raw.shift };
    if (typeof raw.type === "string" && isOpen.peek()) {
      for (const char of raw.type) {
        const next = { text: text.peek().text.slice(0, text.peek().caret) + char + text.peek().text.slice(text.peek().caret), caret: text.peek().caret + char.length };
        setQuery(next);
      }
    }
    if (typeof raw.key === "string" && grab) {
      const key = raw.key === "Enter" ? "Return" : raw.key === "Super" ? "Super_L" : raw.key;
      onKey({ key, state: "pressed", modifiers });
      if (key.startsWith("Super")) {
        onKey({ key, state: "released", modifiers });
      }
    }
    if (raw.pointer && isOpen.peek()) {
      const rect = panelRect(outputRect.peek());
      const x = raw.pointer.panel ? rect.x + raw.pointer.x : raw.pointer.x;
      const y = raw.pointer.panel ? rect.y + raw.pointer.y : raw.pointer.y;
      if (raw.pointer.button) {
        onPointerButton({ position: { x, y }, state: "pressed", buttonName: raw.pointer.button });
        onPointerButton({ position: { x, y }, state: "released", buttonName: raw.pointer.button });
      } else {
        onPointerMotion({ position: { x, y } });
      }
    }
    if (typeof raw.hold === "string" && grab) {
      // Press, hold for `ms`, release: as a held key on the real keyboard.
      const key = raw.hold;
      const startSelected = selected.peek();
      const startText = text.peek().text;
      onKey({ key, state: "pressed", modifiers });
      return new Promise((resolve) => {
        setTimeout(() => {
          onKey({ key, state: "released", modifiers });
          resolve({ held: key, ms: raw.ms ?? 1000, from: startSelected, to: selected.peek(), textBefore: startText, textAfter: text.peek().text, repeating: repeatPoll !== null });
        }, raw.ms ?? 1000);
      });
    }
    if (typeof raw.scroll === "number" && isOpen.peek()) {
      onScroll({ deltaY: raw.scroll });
    }
    const current = layout.peek();
    return {
      open: isOpen.peek(),
      host: host.peek()?.id ?? null,
      helperAlive,
      query: text.peek().text,
      caret: text.peek().caret,
      selected: selected.peek(),
      scroll: scroll.peek(),
      hovered: hovered.peek(),
      context: context.peek() ? { app: context.peek()!.app.name, pinned: context.peek()!.pinned } : null,
      titles: current.entries.map((entry) => entry.item.title),
      sections: (typing.peek() ? results.peek()?.sections ?? [] : []).map((section) => section.kind),
      lastAction,
      input: inputCounts,
      events,
      timing,
      panel: panelRect(outputRect.peek()),
    };
  });

  // ------------------------------------------------------------ drawing

  const BLUR = compileEffect({
    input: backdropSource(),
    capturePadding: 24,
    invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
    alpha: "preserve",
    pipeline: [
      dualKawaseBlur({ radius: 6, passes: 3 }),
      shaderStage(loadShader("./src/effect/rounded-mask.frag"), {
        uniforms: { radius_px: PANEL_RADIUS },
      }),
    ],
  });
  const PANEL_PAINT = paintShader("./src/effect/launcher-panel.frag");
  const SEARCH_PAINT = paintShader("./src/effect/launcher-search.frag");

  const isSelected = (slot: Slot) => computed(() => slot.placed()?.index === selected());
  const isHovered = (slot: Slot) =>
    computed(() => {
      const target = hovered();
      return target?.kind === "entry" && target.index === slot.placed()?.index;
    });
  /** The selection ring and the hover fill of a tile, row or pill. */
  const Frame = ({ slot, width, height, radius }: { slot: Slot; width: number | ReadonlySignal<number>; height: number | ReadonlySignal<number>; radius: number }) => {
    const sel = isSelected(slot);
    const hov = isHovered(slot);
    return (
      <Box
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width,
          height,
          borderRadius: radius,
          border: { px: 1, color: sel((on) => (on ? SELECTED_BORDER : NO_BORDER)) },
          background: computed(() => (hov() && !sel() ? HOVER_FILL : "#00000000")),
          boxShadow: sel((on) => (on ? SELECTED_GLOW : [])),
        }}
      />
    );
  };

  const iconOf = (item: LauncherItem | undefined, section?: SectionKind | string) =>
    item?.icon || (section === "web" ? WEB_ICON : section === "settings" ? SETTINGS_ICON : GENERIC_ICON);

  /**
   * Draw only what is inside the scroll area (a clip nested in the body's
   * clip does not intersect it, so the body alone cannot hide them).
   */
  const inView = (entry: Entry | undefined, home: boolean) => {
    if (!entry) {
      return false;
    }
    const offset = home ? 0 : scroll();
    return entry.y - offset < BODY.height && entry.y + entry.height - offset > 0;
  };

  /**
   * An image rasterized at twice its size and drawn at half: it stays sharp
   * when a hover (1.2x) or the press spring scales it up. `scale` is the
   * extra scale on top (a tile's hover grow).
   */
  const SharpImage = ({
    src,
    left,
    top,
    size,
    scale,
    visible,
  }: {
    src: string | ReadonlySignal<string>;
    left: number;
    top: number | ReadonlySignal<number>;
    size: number;
    scale?: ReadonlySignal<number>;
    visible?: ReadonlySignal<boolean>;
  }) => {
    const grow = (OVERSAMPLE - 1) / 2;
    return (
      <Image
        src={src}
        fit="contain"
        style={{
          position: "absolute",
          left: left - size * grow,
          top: typeof top === "number" ? top - size * grow : top((value) => value - size * grow),
          width: size * OVERSAMPLE,
          height: size * OVERSAMPLE,
          visible,
          transform: { scale: scale ? scale((value) => value / OVERSAMPLE) : 1 / OVERSAMPLE },
        }}
      />
    );
  };

  const Tile = ({ slot, fixed }: { slot: Slot; fixed?: { x: number; y: number } }) => {
    const item = computed(() => slot.placed()?.entry.item);
    return (
      <Box
        style={{
          position: "absolute",
          left: fixed ? fixed.x : computed(() => slot.placed()?.entry.x ?? 0),
          top: fixed ? fixed.y : computed(() => slot.placed()?.entry.y ?? 0),
          width: TILE_WIDTH,
          height: TILE_HEIGHT,
          visible: computed(() => inView(slot.placed()?.entry, !!fixed)),
          transform: { scale: slot.press.value((value) => 1 - 0.1 * value) },
        }}
      >
        <Frame slot={slot} width={TILE_WIDTH} height={TILE_HEIGHT} radius={TILE_RADIUS} />
        <SharpImage
          src={computed(() => iconOf(item()))}
          left={Math.round((TILE_WIDTH - TILE_ICON) / 2)}
          top={TILE_ICON_TOP}
          size={TILE_ICON}
          scale={computed(() => (1 + 0.08 * slot.hover.value()) * (1 - 0.1 * slot.press.value()))}
        />
        <Box
          style={{
            position: "absolute",
            left: px(8),
            top: TILE_LABEL_TOP,
            width: TILE_WIDTH - 2 * px(8),
            height: TILE_LABEL_HEIGHT,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Label
            text={computed(() => item()?.title ?? "")}
            style={{
              color: TEXT,
              fontFamily: FONT,
              fontSize: font(13.5),
              lineHeight: TILE_LABEL_HEIGHT,
              textOverflow: "ellipsis",
              maxWidth: TILE_WIDTH - 2 * px(8),
              flexShrink: 1,
              minWidth: 0,
            }}
          />
        </Box>
      </Box>
    );
  };

  const kindLabel = (section: string | undefined, item: LauncherItem | undefined) => {
    switch (section) {
      case "top":
        return `${item?.action.kind === "exec" ? "App" : item?.action.kind === "open" ? "File" : "Setting"}   Enter`;
      case "math":
        return "Math";
      case "files":
        return "File";
      case "settings":
        return "Setting";
      case "meaning":
        return "Meaning";
      case "web":
        return "Web";
      default:
        return "";
    }
  };

  /** The kind label on the right ("App   Enter", "File"): a fixed column. */
  const KIND_WIDTH = px(150);
  const SUB_PARTS = 5;
  /**
   * A result row (a pill with a title, or a title over a subtitle), or the
   * big pill of the top hit or the math answer. Title and subtitle sit at
   * fixed positions, one block centred vertically; both have fixed widths
   * and end in an ellipsis when too long.
   */
  const Row = ({ slot, pill }: { slot: Slot; pill: boolean }) => {
    const look = pill ? PILL : ROW;
    const entry = computed(() => slot.placed()?.entry);
    const item = computed(() => entry()?.item);
    const height = computed(() => entry()?.height ?? PILL_HEIGHT);
    const hasSub = computed(() => !!item()?.sub);
    const tops = computed(() => rowTextTops(height(), pill, hasSub()));
    const isMath = computed(() => entry()?.section === "math");
    // Only the "By meaning" snippets are highlighted (as in the mock); the
    // ranges of the other results mark letters of the title.
    const parts = computed(() => {
      const value = item();
      const ranges = entry()?.section === "meaning" ? value?.highlight : undefined;
      return value?.sub ? splitHighlights(value.sub, ranges) : [];
    });
    const iconLeft = 1 + look.padLeft;
    const textLeft = iconLeft + look.icon + look.gap;
    const kindLeft = CONTENT_WIDTH - 1 - look.padRight - KIND_WIDTH;
    const textWidth = kindLeft - px(12) - textLeft;
    return (
      <Box
        style={{
          position: "absolute",
          left: CONTENT_X,
          top: computed(() => entry()?.y ?? 0),
          width: CONTENT_WIDTH,
          height,
          visible: computed(() => inView(entry(), false)),
          transform: { scale: slot.press.value((value) => 1 - 0.03 * value) },
        }}
      >
        <Frame slot={slot} width={CONTENT_WIDTH} height={height} radius={999} />
        <SharpImage
          src={computed(() => iconOf(item(), entry()?.section))}
          left={iconLeft}
          top={height((h) => Math.round((h - look.icon) / 2))}
          size={look.icon}
          scale={slot.press.value((value) => 1 - 0.03 * value)}
          visible={isMath((math) => !math)}
        />
        {pill ? (
          <Box
            style={{
              position: "absolute",
              left: iconLeft,
              top: Math.round((PILL_HEIGHT - look.icon) / 2),
              width: look.icon,
              height: look.icon,
              borderRadius: look.icon / 2,
              background: "#ffffff14",
              alignItems: "center",
              justifyContent: "center",
              visible: isMath,
            }}
          >
            <Label text="=" style={{ color: TEXT, fontFamily: FONT, fontSize: font(26), lineHeight: px(34) }} />
          </Box>
        ) : null}
        <Box
          direction="row"
          style={{
            position: "absolute",
            left: textLeft,
            top: tops((value) => value.title),
            width: textWidth,
            height: look.titleLine,
            alignItems: "center",
          }}
        >
          <Label
            text={computed(() => item()?.title ?? "")}
            style={{
              color: TEXT,
              fontFamily: FONT,
              fontSize: look.titleFont,
              lineHeight: look.titleLine,
              textOverflow: "ellipsis",
              flexShrink: 1,
              minWidth: 0,
            }}
          />
          <Box
            style={{
              marginLeft: px(8),
              paddingX: px(8),
              height: px(18),
              borderRadius: px(9),
              background: "#3d8bff40",
              border: { px: 1, color: "#6eaaff80" },
              visible: computed(() => !!item()?.chip),
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <Label text={computed(() => item()?.chip ?? "")} style={{ color: "#cfe3ff", fontFamily: FONT, fontSize: font(12), lineHeight: px(16) }} />
          </Box>
        </Box>
        <Box
          direction="row"
          style={{
            position: "absolute",
            left: textLeft,
            top: tops((value) => value.sub),
            width: textWidth,
            height: look.subLine,
            alignItems: "center",
            visible: hasSub,
          }}
        >
          {Array.from({ length: SUB_PARTS }, (_, k) => {
            const part = computed(() => parts()[k]);
            // The last part also carries any parts beyond it.
            const value = computed(() =>
              k === SUB_PARTS - 1 ? parts().slice(k).map((entry) => entry.text).join("") : (part()?.text ?? ""),
            );
            return (
              <Label
                text={value}
                style={{
                  color: part((entry) => (entry?.mark ? "#ffe6a6" : MUTED)),
                  background: part((entry) => (entry?.mark ? "#ffd66638" : "#00000000")),
                  borderRadius: 3,
                  paddingX: part((entry) => (entry?.mark ? 2 : 0)),
                  fontFamily: FONT,
                  fontSize: look.subFont,
                  lineHeight: look.subLine,
                  textOverflow: "ellipsis",
                  flexShrink: 1,
                  minWidth: 0,
                  visible: part((entry) => entry !== undefined),
                }}
              />
            );
          })}
        </Box>
        <Box
          style={{
            position: "absolute",
            left: kindLeft,
            top: 0,
            width: KIND_WIDTH,
            height,
            alignItems: "center",
          }}
        >
          <Box style={{ flexGrow: 1 }} />
          <Label
            text={computed(() => kindLabel(entry()?.section, item()))}
            style={{ color: MUTED, fontFamily: FONT, fontSize: font(13), lineHeight: px(18) }}
          />
        </Box>
      </Box>
    );
  };

  const SectionTitle = ({ text: label, y, visible }: { text: ReadonlySignal<string> | string; y: ReadonlySignal<number> | number; visible?: ReadonlySignal<boolean> }) => (
    <Box style={{ position: "absolute", left: HEADER_X, top: y, height: HEADER_LINE, alignItems: "center", visible }}>
      <Label text={label} style={{ color: SECTION_COLOR, fontFamily: FONT, fontSize: font(13), lineHeight: HEADER_LINE }} />
    </Box>
  );

  const homeTitles = computed(() => homeLayout().headers);
  // Where each of the 40 home tiles goes (the same for any apps).
  const HOME_POSITIONS = layoutHome({
    recommended: Array.from({ length: 16 }, () => FALLBACK_APPS[0]),
    pinned: Array.from({ length: HOME_TILES - 16 }, () => FALLBACK_APPS[0]),
  }).entries.map(({ x, y }) => ({ x, y }));
  const HomePage = () => (
    <Box style={{ position: "absolute", left: -BODY.x, top: 0, width: PANEL_WIDTH, height: BODY.height, visible: typing((on) => !on) }}>
      {[
        ...[0, 1].map((k) => (
          <SectionTitle text={computed(() => homeTitles()[k]?.text.toUpperCase() ?? "")} y={computed(() => homeTitles()[k]?.y ?? 0)} />
        )),
        ...homeTiles.map((slot, k) => <Tile slot={slot} fixed={HOME_POSITIONS[k]} />),
      ]}
    </Box>
  );

  const ResultsPage = () => {
    const headers = computed(() => resultsLayout().headers);
    const notes = computed(() => resultsLayout().notes);
    return (
      <Box
        style={{
          position: "absolute",
          left: -BODY.x,
          top: scroll((value) => -value),
          width: PANEL_WIDTH,
          height: computed(() => Math.max(BODY.height, resultsLayout().height)),
          visible: typing,
        }}
      >
        {[
          ...Array.from({ length: HEADERS }, (_, k) => (
            <SectionTitle
              text={computed(() => headers()[k]?.text.toUpperCase() ?? "")}
              y={computed(() => headers()[k]?.y ?? 0)}
              visible={computed(() => headers()[k] !== undefined)}
            />
          )),
          ...Array.from({ length: NOTES }, (_, k) => {
            const note = computed(() => notes()[k]);
            const centred = note((value) => value?.text === "Nothing found");
            return (
              <Box
                style={{
                  position: "absolute",
                  left: CONTENT_X + px(14),
                  top: computed(() => note()?.y ?? 0),
                  width: CONTENT_WIDTH - 2 * px(14),
                  height: NOTE_HEIGHT,
                  alignItems: "center",
                  justifyContent: centred((on) => (on ? "center" : "start")),
                  visible: note((value) => value !== undefined),
                }}
              >
                <Label
                  text={note((value) => value?.text ?? "")}
                  style={{ color: MUTED, fontFamily: FONT, fontSize: centred((on) => (on ? font(16) : font(14))), lineHeight: px(20) }}
                />
              </Box>
            );
          }),
          ...resultPills.map((slot) => <Row slot={slot} pill={true} />),
          ...resultRows.map((slot) => <Row slot={slot} pill={false} />),
          ...resultTiles.map((slot) => <Tile slot={slot} />),
        ]}
      </Box>
    );
  };

  const caretVisible = computed(() => caretOn() && isOpen());
  const before = computed(() => text().text.slice(0, text().caret));
  const after = computed(() => text().text.slice(text().caret));
  const searchText = { color: TEXT, fontFamily: FONT, fontSize: SEARCH_FONT, lineHeight: px(31), flexShrink: 0 };
  const Search = () => (
    <Box
      paint={SEARCH_PAINT}
      style={{
        position: "absolute",
        left: SEARCH.x,
        top: SEARCH.y,
        width: SEARCH.width,
        height: SEARCH.height,
        borderRadius: SEARCH.height / 2,
        border: { px: 1, color: "#000000e6" },
        boxShadow: [
          { y: 1, blur: 3, color: "#000000b3", inset: true },
          { y: 1, blur: 0, color: "#ffffff1a" },
          { blur: 0, spread: 1, color: "#fffaf04d" },
          { blur: px(14), color: "#fff6e629" },
        ],
      }}
    >
      <Image
        src="./assets/launcher-search.svg"
        style={{
          position: "absolute",
          left: SEARCH_ICON.x,
          top: Math.round((SEARCH.height - 2 - SEARCH_ICON.size) / 2),
          width: SEARCH_ICON.size,
          height: SEARCH_ICON.size,
        }}
      />
      <Box
        direction="row"
        style={{
          position: "absolute",
          left: SEARCH_TEXT_X,
          top: 0,
          width: SEARCH.width - SEARCH_TEXT_X - px(26),
          height: SEARCH.height - 2,
          alignItems: "center",
          overflow: "hidden",
        }}
      >
        <Label text={before} style={searchText} />
        <Box style={{ width: 2, height: px(27), background: "#ffffff", opacity: caretVisible((on) => (on ? 1 : 0)), flexShrink: 0 }} />
        <Label text={after} style={searchText} />
        <Label text="Search" style={{ ...searchText, color: MUTED, visible: query((value) => value.length === 0) }} />
      </Box>
    </Box>
  );

  // The avatar grows and presses like the lights. A transform replaces its
  // parent's, so the glass and the letter each carry it, both centred.
  const avatarGrow = computed(() => 1 + 0.2 * account.hover.value() - 0.1 * account.press.value());
  const PowerRow = () => (
    <>
      <Box
        style={{
          position: "absolute",
          left: ACCOUNT.x,
          top: ACCOUNT.y,
          width: ACCOUNT.width,
          height: ACCOUNT.height,
          borderRadius: ACCOUNT.height / 2,
          background: computed(() =>
            hovered()?.kind === "account" || selected() === layout().entries.length ? ACCOUNT_HOVER_FILL : "#00000000",
          ),
          transform: { scale: account.press.value((value) => 1 - 0.05 * value) },
        }}
      >
        <Box
          style={{
            position: "absolute",
            left: Math.round((ACCOUNT.height - ACCOUNT.avatar) / 2),
            top: Math.round((ACCOUNT.height - ACCOUNT.avatar) / 2),
            width: ACCOUNT.avatar,
            height: ACCOUNT.avatar,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* The glass and the letter are one image (the letter is a path in the SVG). */}
          <SharpImage src="./assets/launcher-avatar-a.svg" left={0} top={0} size={ACCOUNT.avatar} scale={avatarGrow} />
        </Box>
        <Box style={{ position: "absolute", left: ACCOUNT.nameX, top: 0, height: ACCOUNT.height, alignItems: "center" }}>
          <Label text={ACCOUNT_NAME} style={{ color: TEXT, fontFamily: FONT, fontSize: font(15), lineHeight: px(20) }} />
        </Box>
      </Box>
      {POWER.map((power, k) => {
        const size = lightSize(k);
        const icon = lightIcon(k);
        // A transform on an element replaces its parent's, so each image
        // carries the whole grow (both are centred on the light).
        const grow = computed(() => 1 + 0.2 * lights[k].hover.value() - 0.1 * lights[k].press.value());
        return (
          <Box
            style={{
              position: "absolute",
              left: FIRST_LIGHT_X + k * LIGHT_PITCH + Math.round((LIGHT_BUTTON - size) / 2),
              top: POWER_Y + Math.round((LIGHT_BUTTON - size) / 2),
              width: size,
              height: size,
            }}
          >
            <SharpImage src={power.body} left={0} top={0} size={size} scale={grow} />
            <SharpImage src={`./assets/launcher-icon-${power.id}.svg`} left={(size - icon) / 2} top={(size - icon) / 2} size={icon} scale={grow} />
          </Box>
        );
      })}
    </>
  );

  const ContextPill = () => (
    <Box
      style={{
        position: "absolute",
        left: computed(() => context()?.x ?? 0),
        top: computed(() => context()?.y ?? 0),
        height: CONTEXT_HEIGHT,
        paddingX: px(16),
        borderRadius: CONTEXT_HEIGHT / 2,
        background: "#1d2028f2",
        border: { px: 1, color: "#ffffff40" },
        boxShadow: [{ y: 6, blur: 18, color: "#00000080" }],
        alignItems: "center",
        visible: computed(() => context() !== null),
      }}
    >
      <Label text={computed(() => (context()?.pinned ? "Unpin" : "Pin to Apps"))} style={{ color: TEXT, fontFamily: FONT, fontSize: font(14), lineHeight: px(20) }} />
    </Box>
  );

  const managedRect = computed(() => panelRect(outputRect()));

  function compose(window: WaylandWindow): CompositionRenderable | null {
    if (!isHost(window)) {
      return null;
    }
    // After a config reload the host is already open: no open event comes.
    if (host.peek()?.id !== window.id) {
      queueMicrotask(() => setHost(window));
    }
    const glass = options.glass();
    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={LAUNCHER_Z_INDEX}
        visible={shown}
        opacity={openOpacity}
        interactive={false}
        transform={{ origin: { x: PANEL_WIDTH / 2, y: PANEL_HEIGHT / 2 }, scale: openScale }}
      >
        <Box style={{ position: "relative", width: PANEL_WIDTH, height: PANEL_HEIGHT }}>
          {glass ? (
            <ShaderEffect
              shader={BLUR}
              style={{ position: "absolute", left: 0, top: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT, borderRadius: PANEL_RADIUS }}
            />
          ) : null}
          <Box
            paint={PANEL_PAINT}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: PANEL_WIDTH,
              height: PANEL_HEIGHT,
              borderRadius: PANEL_RADIUS,
              background: GLASS,
              border: { px: 1, color: RIM },
              boxShadow: PANEL_SHADOW,
            }}
          />
          <Search />
          <Box style={{ position: "absolute", left: BODY.x, top: BODY.y, width: BODY.width, height: BODY.height, overflow: "hidden" }}>
            <HomePage />
            <ResultsPage />
          </Box>
          <PowerRow />
          <ContextPill />
          <Box style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "hidden" }}>
            <ClientWindow />
          </Box>
        </Box>
      </ManagedWindow>
    );
  }

  return { compose, isHost, open, close, toggle, isOpen };
}
