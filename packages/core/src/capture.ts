/**
 * Capture: drives the frame stepper through an evaluated Timeline and writes
 * one PNG per Frame. The page states arrive already decided -- the browser
 * consumes the Timeline, it does not participate in producing it.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Viewport } from "./config.js";
import { openFrameStepper } from "./driver.js";
import type { PageState } from "./timeline.js";

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
};

export type CaptureOptions = {
  readonly url: string;
  readonly executable: string;
  readonly viewport: Viewport;
  readonly framerate: number;
  readonly states: readonly PageState[];
  /** Directory the Frames are written into. Created if it is not there. */
  readonly directory: string;
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
  });

  try {
    await stepper.evaluate(stopSmoothScrolling);
    await stepper.evaluate(findScroller);

    for (let frame = 0; frame < settlingFrames; frame++) {
      await stepper.next();
    }
    const repeatedWhileSettling = stepper.repeatedFrames;

    const hashes: string[] = [];
    for (const [index, state] of options.states.entries()) {
      await stepper.evaluate(`window.__recordScroller.scrollTop = ${state.scrollTop}`);
      const frame = await stepper.next();

      await writeFile(join(options.directory, frameFile(index)), frame);
      hashes.push(createHash("sha256").update(frame).digest("hex").slice(0, hashLength));
    }

    return {
      priming: { compositor: stepper.primingFrames, settle: settlingFrames },
      repeated: stepper.repeatedFrames - repeatedWhileSettling,
      hashes,
    };
  } finally {
    await stepper.close();
  }
}

/** Digits in a Frame's number, which is what caps a Run at 100,000 Frames. */
const frameDigits = 5;

/** The name of one Frame's file. */
function frameFile(index: number): string {
  return `frame-${String(index).padStart(frameDigits, "0")}.png`;
}

/** The same naming, as the pattern ffmpeg reads the sequence by. */
export const framePattern = `frame-%0${frameDigits}d.png`;
