// Where is the extra virtual time coming from?
//
// The ramps advanced ~2.1x faster than the budget requested, so each iteration
// is consuming more virtual time than it asked for. Read the page's own clock
// after each step to find out how much, and test whether Playwright's
// screenshot (which does its own stabilisation work) is the culprit by
// comparing it against a raw CDP capture.
import { chromium } from "playwright";

const FIXTURE = new URL("./fixture.html", import.meta.url).href;
const FRAME_MS = 1000 / 60;

async function trial({ label, capture, order }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 800, height: 400 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
  const advance = async (budget, policy = "advance") => {
    const expired = new Promise((r) => cdp.once("Emulation.virtualTimeBudgetExpired", r));
    await cdp.send("Emulation.setVirtualTimePolicy", { policy, budget });
    await expired;
  };
  await page.goto(FIXTURE, { waitUntil: "commit" });
  await advance(500, "pauseIfNetworkFetchesPending");

  const shoot = capture === "playwright"
    ? () => page.screenshot({ type: "png", animations: "allow" })
    : async () => Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64");

  const clock = () => page.evaluate(() => ({ perf: performance.now(), raf: document.getElementById("raf").getBoundingClientRect().width }));

  const samples = [];
  for (let i = 0; i < 12; i++) {
    if (order === "advance-then-shoot") await advance(FRAME_MS);
    await shoot();
    if (order === "shoot-then-advance") await advance(FRAME_MS);
    samples.push({ i, ...(await clock()) });
  }
  await browser.close();
  return { label, samples };
}

const trials = [
  await trial({ label: "playwright screenshot, shoot-then-advance", capture: "playwright", order: "shoot-then-advance" }),
  await trial({ label: "playwright screenshot, advance-then-shoot", capture: "playwright", order: "advance-then-shoot" }),
  await trial({ label: "raw CDP screenshot,   advance-then-shoot", capture: "cdp", order: "advance-then-shoot" }),
  await trial({ label: "raw CDP screenshot,   shoot-then-advance", capture: "cdp", order: "shoot-then-advance" }),
];

for (const t of trials) {
  const perfDeltas = t.samples.slice(1).map((s, i) => s.perf - t.samples[i].perf);
  const mean = perfDeltas.reduce((a, b) => a + b, 0) / perfDeltas.length;
  console.log(`\n=== ${t.label} ===`);
  console.log("  requested per step:  ", FRAME_MS.toFixed(2), "ms");
  console.log("  actual per step:     ", mean.toFixed(2), "ms  (ratio", (mean / FRAME_MS).toFixed(2) + ")");
  console.log("  per-step deltas:     ", perfDeltas.map((d) => d.toFixed(1)).join(", "));
  console.log("  rAF widths:          ", t.samples.map((s) => s.raf.toFixed(0)).join(", "));
}
