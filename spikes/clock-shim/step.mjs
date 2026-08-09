// The stepping primitive ADR 0001 rests on.
//
// Chromium's virtual time policy is set to "pause", then advanced by an exact
// budget per frame. Nothing in the page can observe wall-clock time, so the
// frame we capture after advancing N budgets is a pure function of N.
import { chromium } from "playwright";

export async function openStepped(url, { width, height, deviceScaleFactor = 1 } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      // Without these the compositor can skip painting work it considers
      // unnecessary, which is exactly the work we are trying to capture.
      "--disable-new-content-rendering-timeout",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  // Freeze time before anything loads, so load-time animation starts from a
  // known origin rather than from however long the network took.
  await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });

  const advance = async (budget, policy = "advance") => {
    const expired = new Promise((resolve) => cdp.once("Emulation.virtualTimeBudgetExpired", resolve));
    await cdp.send("Emulation.setVirtualTimePolicy", { policy, budget });
    await expired;
  };

  await page.goto(url, { waitUntil: "commit" });
  // Let load and any network settle inside virtual time, not wall-clock time.
  await advance(2000, "pauseIfNetworkFetchesPending");

  return {
    page,
    cdp,
    advance,
    screenshot: () => page.screenshot({ type: "png", animations: "allow", caret: "initial" }),
    close: () => browser.close(),
  };
}
