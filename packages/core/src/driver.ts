/**
 * The frame stepper: a page whose compositor advances only when told to.
 *
 * Promoted out of `spikes/clock-shim/` rather than rewritten. Each step drives
 * `HeadlessExperimental.beginFrame` *and* advances virtual time by the same
 * interval, because the first moves the compositor clock -- CSS transitions,
 * CSS keyframes, requestAnimationFrame -- while only the second moves the timer
 * queue that `setTimeout` runs on. Both are needed; neither suffices (ADR 0008).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once as onceEvent } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as after } from "node:timers/promises";

import type { ColourScheme } from "./capture.js";
import { connect, type Cdp } from "./cdp.js";
import type { Viewport } from "./config.js";
import { RecordError } from "./errors.js";
import type { KeyStroke } from "./keys.js";
import type { Point } from "./timeline.js";

/**
 * The compositor reports no damage until it has painted once, so a fixed number
 * of Frames is driven before capture -- two, which is what the clock spike
 * measured on every run it ever made. Driving until it happens to paint instead
 * would let the count vary between Runs, and every Frame after it with the
 * count. A page that has not painted by then fails the Run rather than being
 * captured blank.
 */
const primingFrames = 2;

/** How long to wait for the browser to say where its DevTools socket is. */
const launchTimeoutMs = 20_000;

/** How long a browser asked to close politely is given before it is killed. */
const closeTimeoutMs = 2_000;

/** What each cursor event is called, and which buttons it leaves held. */
const cursorEvents: Record<CursorEvent, Record<string, unknown>> = {
  moved: { type: "mouseMoved", button: "none", buttons: 0, clickCount: 0 },
  pressed: { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
  released: { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
};

/** What the cursor does at a point, in the terms the browser dispatches it in. */
export type CursorEvent = "moved" | "pressed" | "released";

export type FrameStepper = {
  /** Frames driven before the compositor first reported damage. */
  readonly primingFrames: number;
  /** Frames the compositor reported undamaged, recorded as repeats. */
  readonly repeatedFrames: number;
  /** Evaluates an expression in the page and returns its value. */
  evaluate(expression: string): Promise<unknown>;
  /** Moves, presses or releases the cursor at a point in the viewport. */
  cursor(event: CursorEvent, point: Point): Promise<void>;
  /** Presses and releases one key, so the page sees a whole keystroke. */
  keyStroke(stroke: KeyStroke): Promise<void>;
  /** Produces the next Frame and returns its PNG. Time only moves forward. */
  next(): Promise<Buffer>;
  /**
   * Drives the next Frame without asking the browser for an image of it, for a
   * Frame nothing keeps: it is driven for what it does to the page, and a PNG
   * rastered only to be thrown away was a third of the images a Run ever asked
   * the browser for.
   *
   * Time moves exactly as it does for a kept Frame, so what is captured after
   * one of these is what would have been captured either way.
   */
  step(): Promise<void>;
  close(): Promise<void>;
};

export type StepperOptions = {
  readonly executable: string;
  readonly viewport: Viewport;
  readonly framerate: number;
  /**
   * An expression evaluated in the page before its own scripts run, and again
   * in any document it goes on to load. What the drawn cursor is installed by.
   */
  readonly overlay?: string;
  /**
   * The colour scheme the reader is said to prefer, told to the browser before
   * the page is navigated to so that the page loads in it rather than being
   * caught changing into it.
   */
  readonly scheme?: ColourScheme;
};

/**
 * A browser of this tool's own, open on a page whose compositor advances only
 * when told to, and everything needed to drive it.
 *
 * There is one way of opening Chrome here, and this is it (ADR 0008): the
 * switches, the target created with begin-frame control, and the clearing up
 * of the profile directory afterwards are the same however the page is used.
 */
export type OpenPage = {
  /** Sends a command to this page and resolves with its result. */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Resolves with the next occurrence of an event. Subscribe before provoking it. */
  once(event: string): Promise<Record<string, unknown>>;
  /** Closes the browser, its renderers and the profile it was launched with. */
  close(): Promise<void>;
};

/**
 * Opens a browser rendering at a device scale factor, which is how many pixels
 * of image each CSS pixel of page is captured as.
 *
 * It is an argument here rather than something set on the target because the
 * switch that decides it is browser-wide, and this is where a browser is
 * launched. `spikes/device-scale/` is the measurement: the per-target
 * `deviceScaleFactor` moves what the page believes `devicePixelRatio` is and
 * never the size of the image, so a page photographed at scale 2 needs both --
 * the switch, or the raster is the CSS size, and the override, or the page
 * lays itself out as a low-density one and is merely upsampled.
 */
export async function openPage(executable: string, deviceScaleFactor: number): Promise<OpenPage> {
  const profile = await mkdtemp(join(tmpdir(), "record-chrome-"));

  let browser: Launched;
  try {
    browser = await launch(executable, profile, deviceScaleFactor);
  } catch (failure) {
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    throw failure;
  }

  let cdp: Cdp;
  try {
    cdp = await connect(browser.wsUrl);
  } catch (failure) {
    await stop(browser.process, profile);
    throw failure;
  }

  // Asking the browser to close takes its renderer processes with it, which
  // killing the one process it was launched as does not.
  const close = async () => {
    await cdp.send("Browser.close").catch(() => undefined);
    cdp.close();
    await stop(browser.process, profile);
  };

  try {
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      // The whole reason for driving CDP directly: Playwright cannot ask for this.
      enableBeginFrameControl: true,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    return {
      send: (method, params) => cdp.send(method, params, sessionId as string),
      once: (event) => cdp.once(event),
      close,
    };
  } catch (failure) {
    await close();
    throw failure;
  }
}

export async function openFrameStepper(url: string, options: StepperOptions): Promise<FrameStepper> {
  const interval = 1000 / options.framerate;
  const page = await openPage(options.executable, options.viewport.deviceScaleFactor);

  /**
   * Cursor moves the browser has been sent but not yet answered. It coalesces
   * them and answers when it next draws, so awaiting one before the Frame it
   * belongs to would cost fifteen seconds a Frame. Commands are processed in
   * the order they were sent, so the move still reaches the page before the
   * Frame that shows it -- only the acknowledgement waits.
   */
  const moving: Promise<unknown>[] = [];
  const settled = () => Promise.all(moving.splice(0));

  const shutDown = async () => {
    // A move left unanswered by a Run that failed would be rejected by the
    // socket closing under it, with nobody left to hear it.
    await settled().catch(() => undefined);
    await page.close();
  };

  try {
    const send = page.send;

    await send("Page.enable");
    await send("Runtime.enable");
    // The viewport in CSS pixels, which is what the Timeline scrolls and clicks
    // in. The scale here is what the page believes its own `devicePixelRatio`
    // is, so a page with a `srcset` or a canvas draws itself at the density it
    // is about to be photographed at; the browser was launched at the same
    // scale, which is what makes the image really that large.
    await send("Emulation.setDeviceMetricsOverride", {
      width: options.viewport.width,
      height: options.viewport.height,
      deviceScaleFactor: options.viewport.deviceScaleFactor,
      mobile: false,
    });

    if (options.scheme !== undefined) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: options.scheme }],
      });
    }

    if (options.overlay !== undefined) {
      await send("Page.addScriptToEvaluateOnNewDocument", { source: options.overlay });
    }

    const loaded = page.once("Page.loadEventFired");
    const navigation = await send("Page.navigate", { url });
    if (typeof navigation["errorText"] === "string") {
      throw new RecordError(`${url} did not load: ${navigation["errorText"]}`);
    }
    await loaded;

    const { virtualTimeTicksBase } = await send("Emulation.setVirtualTimePolicy", { policy: "pause" });
    const base = virtualTimeTicksBase as number;

    let latest: Buffer | undefined;
    /** Whether the compositor has drawn at all, which is what priming waits for. */
    let painted = false;
    let repeated = 0;
    // Frame time only ever moves forward. Stepping the compositor backwards
    // wedges it with no error, so the counter is owned here and callers can
    // only ask for the next Frame.
    let counter = 0;

    const advanceTimerQueue = async () => {
      const expired = page.once("Emulation.virtualTimeBudgetExpired");
      await send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: interval });
      await expired;
    };

    /**
     * One Frame, asked for with an image of it or without one. A Frame nothing
     * keeps is driven for its effect on the page, so asking the browser to
     * raster and encode a PNG of it is work with nowhere to go.
     */
    const drive = async (photograph: boolean): Promise<Buffer | undefined> => {
      await advanceTimerQueue();

      const frame = await send("HeadlessExperimental.beginFrame", {
        frameTimeTicks: base + counter++ * interval,
        interval,
        noDisplayUpdates: false,
        ...(photograph ? { screenshot: { format: "png" } } : {}),
      });

      // A Frame the compositor reports as undamaged is pixel-identical to the
      // one before it and returns no image. A still moment is still a Frame of
      // video, so repeat the last one rather than dropping it.
      //
      // A Frame nobody asked an image of says whether it drew and nothing more,
      // which is the same answer without the picture.
      if (typeof frame["screenshotData"] === "string") {
        latest = Buffer.from(frame["screenshotData"], "base64");
        painted = true;
      } else if (!photograph && frame["hasDamage"] === true) {
        painted = true;
      } else {
        repeated++;
      }

      await settled();

      return latest;
    };

    // Nothing keeps a priming Frame -- they are driven until the compositor has
    // painted at all, which it says for itself.
    for (let frame = 0; frame < primingFrames; frame++) {
      await drive(false);
    }
    if (!painted) {
      throw new RecordError(`${url} had still not painted after ${primingFrames} priming Frames`);
    }

    return {
      primingFrames,
      get repeatedFrames() {
        return repeated;
      },
      async evaluate(expression) {
        const evaluated = await send("Runtime.evaluate", { expression, returnByValue: true });
        const exception = evaluated["exceptionDetails"] as { text?: string } | undefined;
        if (exception !== undefined) {
          throw new RecordError(`the page rejected an expression: ${exception.text ?? "unknown"}`);
        }
        return (evaluated["result"] as { value?: unknown })?.value;
      },
      async cursor(event, point) {
        const dispatched = send("Input.dispatchMouseEvent", {
          ...cursorEvents[event],
          x: point.x,
          y: point.y,
        });

        if (event === "moved") {
          moving.push(dispatched);
          return;
        }
        await dispatched;
      },
      async keyStroke(stroke) {
        const identity = {
          key: stroke.key,
          code: stroke.code,
          windowsVirtualKeyCode: stroke.keyCode,
          nativeVirtualKeyCode: stroke.keyCode,
        };

        // A key that inserts a character has to be dispatched as a keyDown
        // carrying that text; one that does not must be a rawKeyDown, or
        // Chromium treats the empty text as a character and inserts nothing.
        await send("Input.dispatchKeyEvent", {
          ...identity,
          type: stroke.text === undefined ? "rawKeyDown" : "keyDown",
          ...(stroke.text === undefined ? {} : { text: stroke.text }),
        });
        await send("Input.dispatchKeyEvent", { ...identity, type: "keyUp" });
      },
      async next() {
        const frame = await drive(true);
        if (frame === undefined) {
          throw new RecordError("the compositor produced no Frame and none to repeat");
        }
        return frame;
      },
      async step() {
        await drive(false);
      },
      close: shutDown,
    };
  } catch (failure) {
    await shutDown();
    throw failure;
  }
}

type Launched = { readonly process: ChildProcess; readonly wsUrl: string };

async function launch(
  executable: string,
  profile: string,
  deviceScaleFactor: number,
): Promise<Launched> {
  const child = spawn(executable, [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    // BeginFrameControl, and the switches that stop the compositor deciding on
    // its own when to draw.
    "--enable-begin-frame-control",
    "--run-all-compositor-stages-before-draw",
    "--disable-new-content-rendering-timeout",
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
    "--disable-checker-imaging",
    "--disable-image-animation-resync",
    "--hide-scrollbars",
    // What decides how large a captured Frame really is. It is browser-wide, so
    // one browser cannot serve two viewports that differ in it -- which costs
    // nothing, because a page is a browser here.
    `--force-device-scale-factor=${deviceScaleFactor}`,
    "--no-first-run",
    "--disable-gpu",
  ]);

  return new Promise<Launched>((resolve, reject) => {
    let said = "";
    const settle = setTimeout(() => {
      giveUp(new RecordError(`${executable} announced no DevTools endpoint:\n${said}`));
    }, launchTimeoutMs);

    // A browser that will never answer must not be left running, whether it
    // said nothing, failed to start, or died on the way up.
    const giveUp = (failure: RecordError) => {
      clearTimeout(settle);
      child.kill();
      reject(failure);
    };

    const read = (chunk: Buffer | string) => {
      said += String(chunk);
      const endpoint = said.match(/DevTools listening on (ws:\/\/\S+)/);
      if (endpoint?.[1] !== undefined) {
        clearTimeout(settle);
        resolve({ process: child, wsUrl: endpoint[1] });
      }
    };

    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (failure) =>
      giveUp(new RecordError(`could not launch ${executable}: ${failure.message}`)),
    );
    child.on("exit", (code) =>
      giveUp(new RecordError(`${executable} exited with ${code} before it was ready:\n${said}`)),
    );
  });
}

/**
 * The profile directory can only be removed once the browser has let go of it,
 * so the process is waited on rather than merely signalled.
 */
async function stop(child: ChildProcess, profile: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = onceEvent(child, "exit");
    await Promise.race([exited, after(closeTimeoutMs)]);
    child.kill();
    await Promise.race([exited, after(closeTimeoutMs)]).catch(() => undefined);
  }

  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
