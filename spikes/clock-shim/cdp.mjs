// Minimal raw-CDP driver.
//
// Playwright cannot create a target with enableBeginFrameControl, and that flag
// is the whole game -- so the engine talks to the DevTools socket directly.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

export const HEADLESS_SHELL =
  "C:\\Users\\Chris\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe";

function launch(executable) {
  const proc = spawn(executable, [
    "--remote-debugging-port=0",
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "record-"))}`,
    // BeginFrameControl, and the switches that stop the compositor from
    // deciding on its own when to draw.
    "--enable-begin-frame-control",
    "--run-all-compositor-stages-before-draw",
    "--disable-new-content-rendering-timeout",
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
    "--disable-checker-imaging",
    "--disable-image-animation-resync",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--disable-gpu",
  ]);
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve({ proc, wsUrl: m[1] });
    };
    proc.stderr.on("data", onData);
    proc.stdout.on("data", onData);
    setTimeout(() => reject(new Error("no DevTools endpoint:\n" + buf)), 20000);
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 512 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  const ready = new Promise((r) => ws.on("open", r));
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  });
  return {
    send: (method, params = {}, sessionId) =>
      ready.then(
        () =>
          new Promise((resolve, reject) => {
            const myId = ++id;
            pending.set(myId, { resolve, reject });
            ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
          }),
      ),
    once: (method) =>
      new Promise((resolve) => {
        const fns = listeners.get(method) ?? [];
        const fn = (p) => {
          listeners.set(method, (listeners.get(method) ?? []).filter((f) => f !== fn));
          resolve(p);
        };
        listeners.set(method, [...fns, fn]);
      }),
    close: () => ws.close(),
  };
}

/**
 * Opens a page whose compositor advances only when told to.
 * `frame(n)` produces exactly one frame at time base + n*interval and returns
 * its PNG.
 */
export async function openBeginFrame(url, { width, height, fps = 60, advanceTimers = false, deviceScaleFactor = 1, executable = HEADLESS_SHELL } = {}) {
  const interval = 1000 / fps;
  const { proc, wsUrl } = await launch(executable);
  const cdp = connect(wsUrl);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", enableBeginFrameControl: true });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
  await send("Runtime.enable");

  const loaded = cdp.once("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;

  const { virtualTimeTicksBase: base } = await send("Emulation.setVirtualTimePolicy", { policy: "pause" });

  // A frame the compositor reports as undamaged produces no screenshot, because
  // it is pixel-identical to the one before it. Repeat the last frame rather
  // than dropping it -- a still moment is still a frame of video.
  let last = null;
  let repeated = 0;

  // beginFrame drives the compositor clock, which covers CSS animation and
  // requestAnimationFrame -- but not setTimeout, which runs on the timer queue.
  // Advancing virtual time by the same interval each frame is what makes a site
  // that animates with timers behave like one that animates with rAF.
  const advanceTimerQueue = async () => {
    const expired = cdp.once("Emulation.virtualTimeBudgetExpired");
    await send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: interval });
    await expired;
  };

  const beginFrame = async (tick) => {
    if (advanceTimers) await advanceTimerQueue();
    const r = await send("HeadlessExperimental.beginFrame", {
      frameTimeTicks: tick,
      interval,
      noDisplayUpdates: false,
      screenshot: { format: "png" },
    });
    if (r.screenshotData) last = Buffer.from(r.screenshotData, "base64");
    else repeated++;
    return last;
  };

  // Frame time only ever moves forward. Stepping the compositor backwards wedges
  // it, so the tick is owned here and callers can only ask for the next one.
  let n = 0;
  const next = () => beginFrame(base + n++ * interval);

  // The compositor reports no damage until it has painted once, so drive it
  // until the first pixels arrive. The count must be identical between runs or
  // the whole scheme is unsound -- it is returned so callers can assert on it.
  while (last === null && n < 30) await next();
  if (last === null) throw new Error("compositor never painted");
  const primed = n;

  return {
    send,
    interval,
    primed,
    get frameIndex() {
      return n;
    },
    get repeatedFrames() {
      return repeated;
    },
    next,
    close: async () => {
      cdp.close();
      proc.kill();
    },
  };
}
