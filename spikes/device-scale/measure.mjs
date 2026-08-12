// What actually decides how large a captured Frame is.
//
// `viewport.device_scale_factor` has been a Setting the engine drew a control
// for and the capture path ignored: it reaches
// `Emulation.setDeviceMetricsOverride`, and the screenshot
// `HeadlessExperimental.beginFrame` hands back comes out at the CSS viewport
// size regardless. Issue #39 proposes that the launch switch
// `--force-device-scale-factor` is what really decides it.
//
// This measures the claim rather than assuming it: every combination of the
// launch switch and the per-target override, against the size of the PNG that
// comes back and what the page believes its own pixel ratio is.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const HEADLESS_SHELL =
  process.env.RECORD_CHROME ??
  "C:\\Users\\Chris\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe";

/** The CSS viewport every combination is measured at. Small, because this is 16 browsers. */
const VIEWPORT = { width: 400, height: 300 };

/** A page that paints, so the compositor reports damage and returns an image. */
const PAGE =
  "data:text/html," +
  encodeURIComponent(
    "<style>html,body{margin:0;height:100%;background:#3355ff}h1{font:24px sans-serif}</style><h1>scale</h1>",
  );

/** The switches capture launches with, minus the one under test. */
const SWITCHES = [
  "--enable-begin-frame-control",
  "--run-all-compositor-stages-before-draw",
  "--disable-new-content-rendering-timeout",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--disable-checker-imaging",
  "--disable-image-animation-resync",
  "--hide-scrollbars",
  "--no-first-run",
  "--disable-gpu",
];

function launch(forced) {
  const proc = spawn(HEADLESS_SHELL, [
    "--remote-debugging-port=0",
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "spike-scale-"))}`,
    ...SWITCHES,
    ...(forced === null ? [] : [`--force-device-scale-factor=${forced}`]),
  ]);

  return new Promise((resolve, reject) => {
    let said = "";
    const read = (chunk) => {
      said += String(chunk);
      const endpoint = said.match(/DevTools listening on (ws:\/\/\S+)/);
      if (endpoint) resolve({ proc, wsUrl: endpoint[1] });
    };
    proc.stderr.on("data", read);
    proc.stdout.on("data", read);
    setTimeout(() => reject(new Error("no DevTools endpoint:\n" + said)), 20000);
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

/** A PNG's size, straight out of the IHDR chunk. */
function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * One combination measured: a browser launched under `forced`, a target
 * overridden at `override`, and the size of the image that comes back.
 *
 * `override === null` sets no device metrics at all, which is the control: it
 * says what the launch switch does on its own.
 */
async function measure(forced, override) {
  const { proc, wsUrl } = await launch(forced);
  const cdp = connect(wsUrl);

  try {
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      enableBeginFrameControl: true,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);

    await send("Page.enable");
    await send("Runtime.enable");

    if (override !== null) {
      await send("Emulation.setDeviceMetricsOverride", {
        ...VIEWPORT,
        deviceScaleFactor: override,
        mobile: false,
      });
    }

    const loaded = cdp.once("Page.loadEventFired");
    await send("Page.navigate", { url: PAGE });
    await loaded;

    // The compositor reports no damage until it has painted, so the first
    // frames come back without an image at all.
    let image;
    for (let frame = 0; frame < 5 && image === undefined; frame++) {
      const drawn = await send("HeadlessExperimental.beginFrame", {
        noDisplayUpdates: false,
        screenshot: { format: "png" },
      });
      if (typeof drawn.screenshotData === "string") {
        image = Buffer.from(drawn.screenshotData, "base64");
      }
    }

    const believed = await send("Runtime.evaluate", {
      expression: "[devicePixelRatio, innerWidth, innerHeight].join('x')",
      returnByValue: true,
    });

    return {
      frame: image === undefined ? null : pngSize(image),
      page: believed.result?.value ?? "?",
    };
  } finally {
    cdp.close();
    proc.kill();
  }
}

const launches = [null, 1, 2, 3];
const overrides = [null, 1, 2, 3];

console.log(`CSS viewport ${VIEWPORT.width}x${VIEWPORT.height}. 'frame' is what beginFrame returned.\n`);
console.log("--force-device-scale-factor  setDeviceMetricsOverride  frame       page dpr/inner");
console.log("-".repeat(82));

for (const forced of launches) {
  for (const override of overrides) {
    const { frame, page } = await measure(forced, override);
    const size = frame === null ? "none" : `${frame.width}x${frame.height}`;
    console.log(
      `${String(forced ?? "absent").padEnd(28)}${String(override ?? "absent").padEnd(26)}${size.padEnd(12)}${page}`,
    );
  }
}
