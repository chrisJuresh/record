/**
 * Capture: drives the frame stepper through an evaluated Timeline and writes
 * one PNG per Frame. The page states arrive already decided -- the browser
 * consumes the Timeline, it does not participate in producing it.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Viewport } from "./config.js";
import type { CursorOverlay } from "./cursor.js";
import { openFrameStepper, type FrameStepper } from "./driver.js";
import { RecordError } from "./errors.js";
import type { Substitution, TextSubstitution } from "./text.js";
import type { ThemeSwitch } from "./theme.js";
import type { CursorState, PageEffect, PageState } from "./timeline.js";

/**
 * Frames driven after the page is prepared and before the first Frame is kept,
 * so that images finish decoding and any load-time animation finishes running.
 * A fixed count rather than a wait, because a wait would depend on the machine.
 */
const settlingFrames = 60;

/** How many digits of each Frame's hash are kept. Golden assertions store these, never images. */
const hashLength = 16;

export type CapturedFrames = {
  /** Frames driven before the first Frame was kept. */
  readonly priming: { readonly compositor: number; readonly settle: number };
  /** Frames the compositor reported undamaged, recorded as repeats of the one before. */
  readonly repeated: number;
  /** One hash per captured Frame, in order. */
  readonly hashes: readonly string[];
  /** The copy substituted into the page, and what each selector matched. */
  readonly substituted: readonly Substitution[];
  /**
   * How the page reads, which is what a Mockup left to choose itself is chosen
   * by. Asked of the page once, so it cannot make two Runs of one Action
   * differ.
   */
  readonly colourScheme: ColourScheme;
};

export type CaptureOptions = {
  readonly url: string;
  readonly executable: string;
  readonly viewport: Viewport;
  readonly framerate: number;
  readonly states: readonly PageState[];
  /** Directory the Frames are written into. Created if it is not there. */
  readonly directory: string;
  /** The cursor drawn over the page, where this Run draws one at all. */
  readonly overlay?: CursorOverlay;
  /** The copy substituted into the page, where the Action declares any. */
  readonly substitution?: TextSubstitution;
  /** How the page is put into a colour scheme, where a Condition asked for one. */
  readonly theme?: ThemeSwitch;
  /**
   * Told how many Frames have been written, as each one is. Capture is the long
   * part of a Run by far, so this is what stops a ten-second render looking like
   * a hang. It is watched rather than recorded: nothing a Run reports depends on
   * whether anybody was listening.
   */
  readonly progress?: (captured: number) => void;
};

/** How a page reads, which is one of the things a Run reports about the page it recorded. */
export type ColourScheme = "light" | "dark";

/**
 * What a page reads as, as the page itself answers it: the colour it actually
 * paints behind its content, taken from the body and then from the document. A
 * page painting nothing is white, which is what a browser shows.
 *
 * Asked of the page rather than of its stylesheet, so that a page dark by its
 * own design is read the same way as one dark by preference.
 */
const colourScheme = `
  (() => {
    const painted = (element) => {
      if (element === null) {
        return null;
      }
      const parts = getComputedStyle(element).backgroundColor.match(/[\\d.]+/g);
      if (parts === null || parts.length < 3) {
        return null;
      }
      const [red, green, blue, alpha] = parts.map(Number);
      if (alpha === 0) {
        return null;
      }
      return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    };

    const lightness = painted(document.body) ?? painted(document.documentElement) ?? 1;

    return lightness < 0.5 ? "dark" : "light";
  })()
`;

/** Smooth scrolling would fight a scroll position chosen per Frame. */
const stopSmoothScrolling = `
  (() => {
    const style = document.createElement("style");
    style.textContent = "*,html,body{scroll-behavior:auto !important}";
    document.head.appendChild(style);
  })()
`;

/**
 * The page may scroll the document or an inner container. Whichever actually
 * scrolls is found once and driven for the whole Run, so that the Frames of one
 * Action cannot be split across two scrollers.
 */
const findScroller = `
  (() => {
    const document_ = document.scrollingElement || document.documentElement;
    if (document_.scrollHeight > document_.clientHeight + 4) {
      window.__recordScroller = document_;
      return;
    }
    let best = null;
    let deepest = 0;
    for (const element of document.querySelectorAll("*")) {
      const overflow = element.scrollHeight - element.clientHeight;
      const scrollable = /(auto|scroll)/.test(getComputedStyle(element).overflowY);
      if (scrollable && overflow > deepest) {
        best = element;
        deepest = overflow;
      }
    }
    window.__recordScroller = best || document_;
  })()
`;

export async function captureFrames(options: CaptureOptions): Promise<CapturedFrames> {
  await mkdir(options.directory, { recursive: true });

  const stepper = await openFrameStepper(options.url, {
    executable: options.executable,
    viewport: options.viewport,
    framerate: options.framerate,
    ...(options.overlay === undefined ? {} : { overlay: options.overlay.script }),
    // Told to the browser before the page is navigated to, so a page built on
    // the media query loads in the scheme rather than changing into it.
    ...(options.theme?.kind === "emulated" ? { scheme: options.theme.scheme } : {}),
  });

  try {
    await stepper.evaluate(stopSmoothScrolling);

    // A Project that switches its own theme is switched by its own hook, before
    // anything is substituted into the page: a theme is free to change what the
    // page says as well as how it looks.
    if (options.theme?.kind === "hook") {
      await stepper.evaluate(options.theme.expression);
    }

    // Before the scroller is found and before anything settles: replacement
    // copy is as free to change the page's height as its wording, so the Run
    // has to find its scroller in the page it is about to photograph.
    const substituted =
      options.substitution === undefined
        ? []
        : options.substitution.substituted(await stepper.evaluate(options.substitution.script));

    await stepper.evaluate(findScroller);

    for (let frame = 0; frame < settlingFrames; frame++) {
      await stepper.next();
    }
    const repeatedWhileSettling = stepper.repeatedFrames;

    // Asked once the page has settled, so what is read is the page the Frames
    // are about to be of rather than the page as it was served -- a page that
    // paints its dark theme on the way up is dark by now. Asked once, so it
    // cannot make two Runs of one Action differ.
    const reads: ColourScheme =
      (await stepper.evaluate(colourScheme)) === "dark" ? "dark" : "light";

    const hashes: string[] = [];
    let cursor: CursorState | null = null;

    for (const [index, state] of options.states.entries()) {
      // The page is put where the Frame says it is, the cursor is carried to
      // where the Frame says it is, and only then does the Frame's own work
      // happen -- so a click lands on what the viewer can see it land on.
      await stepper.evaluate(`window.__recordScroller.scrollTop = ${state.scrollTop}`);

      if (state.cursor !== null && (state.cursor.x !== cursor?.x || state.cursor.y !== cursor.y)) {
        await stepper.cursor("moved", state.cursor);
      }
      cursor = state.cursor;

      for (const effect of state.does) {
        await apply(stepper, effect, state);
      }

      // Drawn last, so that what the cursor shows is this Frame as it will be
      // photographed: the page where the Timeline put it, the press already
      // pressed, and the keys of this Frame already struck.
      if (options.overlay !== undefined) {
        await stepper.evaluate(options.overlay.draws(state));
      }

      const frame = await stepper.next();

      await writeFile(join(options.directory, frameFile(index)), frame);
      hashes.push(createHash("sha256").update(frame).digest("hex").slice(0, hashLength));

      options.progress?.(hashes.length);
    }

    return {
      priming: { compositor: stepper.primingFrames, settle: settlingFrames },
      repeated: stepper.repeatedFrames - repeatedWhileSettling,
      hashes,
      substituted,
      colourScheme: reads,
    };
  } finally {
    await stepper.close();
  }
}

/** Does to the page what one Frame of the evaluated Timeline says is done to it. */
async function apply(stepper: FrameStepper, effect: PageEffect, state: PageState): Promise<void> {
  switch (effect.kind) {
    case "cursor-press":
      return stepper.cursor("pressed", clicking(state));
    case "cursor-release":
      return stepper.cursor("released", clicking(state));
    case "key":
      return stepper.keyStroke(effect.stroke);
    case "evaluate":
      await stepper.evaluate(effect.expression);
      return;
    case "require": {
      // The Timeline decided how long to wait; all that is left is whether the
      // wait was long enough, and a Run that carried on regardless would encode
      // a clip of the thing never happening.
      if (!(await stepper.evaluate(effect.condition))) {
        throw new RecordError(
          `the Action waited for ${effect.describes}, which never became true`,
        );
      }
      return;
    }
  }
}

/** Where a click lands: wherever the Frame says the cursor is. */
function clicking(state: PageState): CursorState {
  if (state.cursor === null) {
    throw new RecordError("a Frame clicks without the cursor being anywhere");
  }
  return state.cursor;
}

/** Digits in a Frame's number, which is what caps a Run at 100,000 Frames. */
const frameDigits = 5;

/** The name of one Frame's file. */
export function frameFile(index: number): string {
  return `frame-${String(index).padStart(frameDigits, "0")}.png`;
}

/** The same naming, as the pattern ffmpeg reads the sequence by. */
export const framePattern = `frame-%0${frameDigits}d.png`;
