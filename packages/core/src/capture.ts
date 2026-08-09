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
};

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
  });

  try {
    await stepper.evaluate(stopSmoothScrolling);

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
    }

    return {
      priming: { compositor: stepper.primingFrames, settle: settlingFrames },
      repeated: stepper.repeatedFrames - repeatedWhileSettling,
      hashes,
      substituted,
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
function frameFile(index: number): string {
  return `frame-${String(index).padStart(frameDigits, "0")}.png`;
}

/** The same naming, as the pattern ffmpeg reads the sequence by. */
export const framePattern = `frame-%0${frameDigits}d.png`;
