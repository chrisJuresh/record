/**
 * The synthetic cursor: the pointer drawn into the page, because no Frame
 * contains the operating system's own and there is no real mouse in a stepped
 * headless browser.
 *
 * Everything drawn is decided by the Timeline -- where the cursor is, whether
 * it is held down, how far each click's ripple has spread, and which keys were
 * struck near this Frame. Nothing is left to an animation in the page, so two
 * Runs of one Action draw the same pointer in the same places.
 *
 * The styles are a registry. Adding one is adding an entry: nothing in the
 * pipeline names a style, and the overlay draws whatever the entry describes.
 */
import { RecordError } from "./errors.js";
import { flagSetting, nameSetting, type Settled } from "./settings.js";
import type { PageState, Point, Timeline } from "./timeline.js";

/** One way of drawing the cursor: its shape, its press, and what a click sends out. */
export type CursorStyle = {
  readonly name: string;
  /** How big the shape is drawn, in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Where the shape's point sits inside its own box, as a fraction of it. */
  readonly hotspot: Point;
  /** The shape, as SVG filling that box. */
  readonly svg: string;
  /** How far the shape shrinks while the cursor is held down. */
  readonly pressedScale: number;
  /** The ring a click sends out: how far it spreads from the point, and in what. */
  readonly ripple: {
    readonly from: number;
    readonly to: number;
    readonly colour: string;
  };
};

/** The classic pointer arrow, drawn once and coloured twice below. */
const arrow = (fill: string, outline: string): string =>
  `<svg viewBox="0 0 20 31" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">` +
  `<path d="M1.5 1.5L1.5 25.5L7 20.5L10.6 29.5L14 28L10.4 19.4L17 19Z" fill="${fill}" ` +
  `stroke="${outline}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

/**
 * The cursors that ship. Each is one entry and nothing else: no branch anywhere
 * else names a style, so a fourth is written here and is immediately settable.
 */
export const cursorStyles: Readonly<Record<string, CursorStyle>> = {
  "soft-dot": {
    name: "soft-dot",
    width: 30,
    height: 30,
    hotspot: { x: 0.5, y: 0.5 },
    svg:
      `<svg viewBox="0 0 30 30" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="15" cy="15" r="12" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="2"/>` +
      `<circle cx="15" cy="15" r="6.5" fill="rgba(20,20,22,0.78)"/></svg>`,
    pressedScale: 0.82,
    ripple: { from: 8, to: 30, colour: "rgba(255,255,255,0.92)" },
  },
  "arrow-light": {
    name: "arrow-light",
    width: 20,
    height: 31,
    hotspot: { x: 0.075, y: 0.048 },
    svg: arrow("#ffffff", "rgba(0,0,0,0.55)"),
    pressedScale: 0.9,
    ripple: { from: 6, to: 26, colour: "rgba(255,255,255,0.9)" },
  },
  "arrow-dark": {
    name: "arrow-dark",
    width: 20,
    height: 31,
    hotspot: { x: 0.075, y: 0.048 },
    svg: arrow("#111214", "rgba(255,255,255,0.85)"),
    pressedScale: 0.9,
    ripple: { from: 6, to: 26, colour: "rgba(17,18,20,0.75)" },
  },
};

/** Every style that ships, in the order they are declared above. */
export const cursorStyleNames: readonly string[] = Object.keys(cursorStyles);

/**
 * The Parameters every Action carries for the cursor. They describe what is
 * drawn over the page rather than what moves, and an Action describes motion,
 * so no Action declares them -- every Action carries them, and a new Action is
 * tunable the moment it exists.
 *
 * Visibility is a choice of three rather than a flag because its default is not
 * a value: a cursor belongs in an Action that clicks or types and is a
 * distraction in one that only scrolls, and `auto` is how that is said without
 * every Action having to say it.
 */
export const cursorParameters = {
  cursor: {
    kind: "choice",
    describes: "Whether the cursor is drawn -- automatically for an Action that clicks or types",
    default: "auto",
    choices: ["auto", "shown", "hidden"],
  },
  cursorStyle: {
    kind: "choice",
    describes: "Which cursor is drawn",
    default: "soft-dot",
    choices: cursorStyleNames,
  },
  cursorCaptions: {
    kind: "flag",
    describes: "Caption the keys the Action strikes on screen",
    default: false,
  },
} as const;

/** What a Run draws over the page, once its Parameters have been resolved. */
export type CursorSettings = {
  readonly shown: boolean;
  readonly style: CursorStyle;
  readonly captions: boolean;
};

/** The overlay a Run draws with: injected once, then asked for each Frame. */
export type CursorOverlay = {
  /**
   * Injected before the page's own scripts run, so that the cursor is there
   * whatever the page does on the way up.
   */
  readonly script: string;
  /** What one Frame draws, as an expression evaluated in the page. */
  draws(state: PageState): string;
};

/**
 * What one Run draws, out of the Parameter values it resolved and the Timeline
 * it is about to record.
 *
 * `auto` is answered by the Timeline itself: an Action containing a click or a
 * type primitive is one a pointer explains, and an Action that only travels is
 * one a pointer sits idle in. An Action that places no cursor at all draws
 * none whatever it does, because there is nowhere to draw it.
 */
export function cursorSettings(values: Settled, timeline: Timeline): CursorSettings {
  const asked = nameSetting(values, "cursor");
  const placed = timeline.startsAt.cursor != null;

  // Being asked for a cursor the Action never places is a different thing from
  // there being none to draw: the first is an Override that could only ever
  // draw nothing, and saying so is the only way whoever set it finds out. An
  // Action that types without a pointer is the ordinary second case, and
  // records with no cursor rather than failing.
  if (asked === "shown" && !placed) {
    throw new RecordError(
      "this Action never places a cursor, so there is none to draw -- an Action that " +
        "shows one declares where it starts, as motion({ startsAt: { cursor } })",
    );
  }

  return {
    shown: placed && (asked === "auto" ? showsCursor(timeline) : asked === "shown"),
    style: cursorStyle(nameSetting(values, "cursorStyle")),
    captions: flagSetting(values, "cursorCaptions"),
  };
}

/** One style by name, or a failure naming the ones that ship. */
function cursorStyle(name: string): CursorStyle {
  const style = cursorStyles[name];

  if (style === undefined) {
    throw new RecordError(
      `'${name}' is not a cursor style. There is ${cursorStyleNames.join(", ")}`,
    );
  }
  return style;
}

/**
 * The overlay a Run draws with, or nothing at all when it draws nothing --
 * which leaves the page exactly as it would have been recorded without a
 * cursor, rather than carrying an overlay that happens to be empty.
 */
export function cursorOverlay(settings: CursorSettings): CursorOverlay | undefined {
  if (!settings.shown && !settings.captions) {
    return undefined;
  }

  // One expression rather than a script of statements: a `const` at the top
  // level of an injected script is a global binding, and a page declaring the
  // same name would then fail to load.
  return {
    script: [
      "(() => {",
      `const style = ${JSON.stringify(settings.style)};`,
      `const drawsPointer = ${String(settings.shown)};`,
      overlay,
      "})()",
    ].join("\n"),
    draws: (state) =>
      `window.__recordCursor(${JSON.stringify({
        cursor: state.cursor,
        caption: settings.captions ? state.caption : null,
      })})`,
  };
}

/**
 * Whether an Action is one a drawn pointer explains. Clicking and typing are
 * things a viewer has to be shown happening; travel shows itself.
 */
function showsCursor(timeline: Timeline): boolean {
  return timeline.segments.some(
    (segment) => segment.kind === "click" || segment.kind === "type",
  );
}

/**
 * The overlay itself, as the page runs it. It is handed a style and whether to
 * draw a pointer at all, and is then told the state of each Frame.
 *
 * It lives in a shadow root so that the page's own stylesheet cannot reach it
 * and it cannot reach the page's, and it writes to the DOM only when what it
 * would write has changed -- a Frame in which nothing moved has to stay
 * undamaged, or the compositor would draw every still moment afresh.
 */
const overlay = `
  let parts = null;

  const install = () => {
    const host = document.createElement("div");
    host.setAttribute("data-record-cursor", "");
    host.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";

    const shadow = host.attachShadow({ mode: "open" });

    const ripples = document.createElement("div");

    const pointer = document.createElement("div");
    pointer.style.cssText =
      "position:absolute;left:0;top:0;display:none;width:" + style.width + "px;height:" +
      style.height + "px;transform-origin:" + style.hotspot.x * 100 + "% " +
      style.hotspot.y * 100 + "%";
    pointer.innerHTML = style.svg;

    const caption = document.createElement("div");
    caption.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:none;" +
      "padding:8px 14px;border-radius:10px;background:rgba(17,18,20,0.86);color:#ffffff;" +
      "font:600 16px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre";

    shadow.append(ripples, pointer, caption);
    (document.body || document.documentElement).append(host);

    parts = { ripples, pointer, caption, spreading: "" };
  };

  const write = (element, property, value) => {
    if (element.style[property] !== value) {
      element.style[property] = value;
    }
  };

  window.__recordCursor = (state) => {
    if (parts === null) {
      install();
    }

    const cursor = drawsPointer ? state.cursor : null;

    write(parts.pointer, "display", cursor === null ? "none" : "block");

    let spreading = "";

    if (cursor !== null) {
      write(
        parts.pointer,
        "transform",
        "translate(" + (cursor.x - style.hotspot.x * style.width) + "px," +
          (cursor.y - style.hotspot.y * style.height) + "px) scale(" +
          (cursor.pressed ? style.pressedScale : 1) + ")",
      );

      // Each ripple is drawn where its own click landed, not where the cursor
      // has got to since: a click marks the place it happened.
      for (const ripple of cursor.ripples) {
        const radius = style.ripple.from + (style.ripple.to - style.ripple.from) * ripple.spread;
        spreading +=
          '<div style="position:absolute;border-radius:50%;border:2px solid ' +
          style.ripple.colour + ';left:' + (ripple.x - radius) + 'px;top:' +
          (ripple.y - radius) + 'px;width:' + radius * 2 + 'px;height:' + radius * 2 +
          'px;opacity:' + (1 - ripple.spread).toFixed(3) + '"></div>';
      }
    }

    if (parts.spreading !== spreading) {
      parts.ripples.innerHTML = spreading;
      parts.spreading = spreading;
    }

    const caption = state.caption === null ? "" : state.caption;

    if (parts.caption.textContent !== caption) {
      parts.caption.textContent = caption;
    }
    write(parts.caption, "display", caption === "" ? "none" : "block");
  };
`;
