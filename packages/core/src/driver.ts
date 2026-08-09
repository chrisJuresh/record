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
  /** Inserts text into whatever has focus, as typing it would. */
  insertText(text: string): Promise<void>;
  /** Produces the next Frame and returns its PNG. Time only moves forward. */
  next(): Promise<Buffer>;
  close(): Promise<void>;
};

export type StepperOptions = {
  readonly executable: string;
  readonly viewport: Viewport;
  readonly framerate: number;
};

export async function openFrameStepper(url: string, options: StepperOptions): Promise<FrameStepper> {
  const interval = 1000 / options.framerate;
  const profile = await mkdtemp(join(tmpdir(), "record-chrome-"));

  let browser: Launched;
  try {
    browser = await launch(options.executable, profile);
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

  /**
   * Cursor moves the browser has been sent but not yet answered. It coalesces
   * them and answers when it next draws, so awaiting one before the Frame it
   * belongs to would cost fifteen seconds a Frame. Commands are processed in
   * the order they were sent, so the move still reaches the page before the
   * Frame that shows it -- only the acknowledgement waits.
   */
  const moving: Promise<unknown>[] = [];
  const settled = () => Promise.all(moving.splice(0));

  // Asking the browser to close takes its renderer processes with it, which
  // killing the one process it was launched as does not.
  const shutDown = async () => {
    // A move left unanswered by a Run that failed would be rejected by the
    // socket closing under it, with nobody left to hear it.
    await settled().catch(() => undefined);
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
    const send = (method: string, params?: Record<string, unknown>) =>
      cdp.send(method, params, sessionId as string);

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: options.viewport.width,
      height: options.viewport.height,
      deviceScaleFactor: options.viewport.deviceScaleFactor,
      mobile: false,
    });

    const loaded = cdp.once("Page.loadEventFired");
    const navigation = await send("Page.navigate", { url });
    if (typeof navigation["errorText"] === "string") {
      throw new RecordError(`${url} did not load: ${navigation["errorText"]}`);
    }
    await loaded;

    const { virtualTimeTicksBase } = await send("Emulation.setVirtualTimePolicy", { policy: "pause" });
    const base = virtualTimeTicksBase as number;

    let latest: Buffer | undefined;
    let repeated = 0;
    // Frame time only ever moves forward. Stepping the compositor backwards
    // wedges it with no error, so the counter is owned here and callers can
    // only ask for the next Frame.
    let counter = 0;

    const advanceTimerQueue = async () => {
      const expired = cdp.once("Emulation.virtualTimeBudgetExpired");
      await send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: interval });
      await expired;
    };

    const next = async (): Promise<Buffer | undefined> => {
      await advanceTimerQueue();

      const frame = await send("HeadlessExperimental.beginFrame", {
        frameTimeTicks: base + counter++ * interval,
        interval,
        noDisplayUpdates: false,
        screenshot: { format: "png" },
      });

      // A Frame the compositor reports as undamaged is pixel-identical to the
      // one before it and returns no image. A still moment is still a Frame of
      // video, so repeat the last one rather than dropping it.
      if (typeof frame["screenshotData"] === "string") {
        latest = Buffer.from(frame["screenshotData"], "base64");
      } else {
        repeated++;
      }

      await settled();

      return latest;
    };

    for (let frame = 0; frame < primingFrames; frame++) {
      await next();
    }
    if (latest === undefined) {
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
      async insertText(text) {
        await send("Input.insertText", { text });
      },
      async next() {
        const frame = await next();
        if (frame === undefined) {
          throw new RecordError("the compositor produced no Frame and none to repeat");
        }
        return frame;
      },
      close: shutDown,
    };
  } catch (failure) {
    await shutDown();
    throw failure;
  }
}

type Launched = { readonly process: ChildProcess; readonly wsUrl: string };

async function launch(executable: string, profile: string): Promise<Launched> {
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
    // The device pixel ratio is set per target instead, so that one browser
    // could serve viewports that differ in it.
    "--force-device-scale-factor=1",
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
