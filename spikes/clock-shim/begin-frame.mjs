// Can we drive the compositor one frame at a time with an exact timestamp?
//
// HeadlessExperimental.beginFrame produces exactly one frame at a caller-chosen
// time and returns its screenshot in the same call -- precisely what
// deterministic capture needs. It is gated behind BeginFrameControl, which
// requires the target to be created with enableBeginFrameControl and the
// browser launched with the matching switch. Playwright creates its own targets
// and cannot pass that flag, so drive raw CDP over the DevTools socket.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.argv[2] ?? "C:\\Users\\Chris\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe";
const FIXTURE = new URL("./fixture.html", import.meta.url).href;
const INTERVAL = 1000 / 60;

function launch() {
  const proc = spawn(CHROME, [
    "--headless",
    "--remote-debugging-port=0",
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "spike-"))}`,
    "--enable-begin-frame-control",
    "--run-all-compositor-stages-before-draw",
    "--disable-new-content-rendering-timeout",
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
    "--disable-checker-imaging",
    "--disable-image-animation-resync",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-sandbox",
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
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const ready = new Promise((r) => ws.on("open", r));
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const send = (method, params = {}, sessionId) =>
    ready.then(
      () =>
        new Promise((resolve, reject) => {
          const myId = ++id;
          pending.set(myId, { resolve, reject });
          ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
        }),
    );
  return { send, close: () => ws.close() };
}

const { proc, wsUrl } = await launch();
const cdp = connect(wsUrl);

const { targetId } = await cdp.send("Target.createTarget", {
  url: "about:blank",
  enableBeginFrameControl: true,
});
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 400, deviceScaleFactor: 1, mobile: false }, sessionId);
await cdp.send("Page.navigate", { url: FIXTURE }, sessionId);
await new Promise((r) => setTimeout(r, 1500)); // let the fixture load; wall-clock is fine here

// beginFrame needs a monotonic base in renderer TimeTicks.
const { virtualTimeTicksBase } = await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" }, sessionId);

const results = [];
for (let i = 0; i < 8; i++) {
  const r = await cdp
    .send(
      "HeadlessExperimental.beginFrame",
      {
        frameTimeTicks: virtualTimeTicksBase + i * INTERVAL,
        interval: INTERVAL,
        noDisplayUpdates: false,
        screenshot: { format: "png" },
      },
      sessionId,
    )
    .catch((e) => ({ error: e.message }));
  results.push(r);
}

console.log("beginFrame results:");
for (const [i, r] of results.entries()) {
  if (r.error) console.log(`  frame ${i}: ERROR ${r.error}`);
  else console.log(`  frame ${i}: hasDamage=${r.hasDamage} screenshotBytes=${r.screenshotData ? Buffer.from(r.screenshotData, "base64").length : 0}`);
}

const ok = results.every((r) => !r.error && r.screenshotData);
console.log("\nRESULT:", ok ? "beginFrame WORKS -- exact single-frame stepping is available" : "beginFrame UNAVAILABLE");

cdp.close();
proc.kill();
process.exit(ok ? 0 : 1);
