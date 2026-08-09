// Does frame production scale with the virtual time budget?
//
// Established so far: the clock advances exactly as budgeted, rAF is paced by
// frames produced rather than by the budget, and advancing with no screenshot
// deadlocks (the budget never expires) -- so virtual time is gated on frame
// production. The remaining question is whether a larger budget yields
// proportionally more frames. If it does, one frame per step is achievable and
// virtual time is the mechanism. If it does not, we need beginFrame.
import { chromium } from "playwright";

const COUNTER = `
  window.__ticks = [];
  (function loop(t) { window.__ticks.push(t); requestAnimationFrame(loop); })(0);
`;

async function trial(budgetMs) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 400, height: 200 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
  const advance = async (budget, policy = "advance") => {
    const expired = new Promise((r) => cdp.once("Emulation.virtualTimeBudgetExpired", r));
    await cdp.send("Emulation.setVirtualTimePolicy", { policy, budget });
    await expired;
  };

  await page.goto("data:text/html,<body style='background:#fff'>hi", { waitUntil: "commit" });
  await advance(200, "pauseIfNetworkFetchesPending");
  await page.evaluate(COUNTER);
  await page.evaluate(() => { window.__ticks.length = 0; });

  const perStep = [];
  for (let i = 0; i < 5; i++) {
    const before = await page.evaluate(() => window.__ticks.length);
    await advance(budgetMs);
    await cdp.send("Page.captureScreenshot", { format: "png" });
    perStep.push((await page.evaluate(() => window.__ticks.length)) - before);
  }
  const ticks = await page.evaluate(() => window.__ticks);
  await browser.close();
  const deltas = ticks.slice(1).map((t, i) => +(t - ticks[i]).toFixed(1));
  return { budgetMs, perStep, deltas };
}

for (const budget of [8.333, 16.667, 33.333, 100]) {
  const r = await trial(budget);
  const totalClock = r.deltas.reduce((a, b) => a + b, 0);
  console.log(
    `budget ${String(budget.toFixed(1)).padStart(6)}ms  ->  rAF ticks/step: ${r.perStep.join(",")}  ` +
      `| tick deltas: ${r.deltas.join(",")}  | animation clock advanced ${totalClock.toFixed(1)}ms over ${(budget * 5).toFixed(1)}ms of budget`,
  );
}
