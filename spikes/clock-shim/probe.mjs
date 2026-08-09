// Which time-control mechanisms does this Chromium actually expose?
//
// ADR 0001 depends on being able to advance the page's own clock -- CSS
// transitions, CSS keyframes, and requestAnimationFrame -- in lockstep with a
// frame counter. There are three candidate mechanisms and the literature
// disagrees about which survive in current Chromium, so probe rather than
// assume.
import { chromium } from "playwright";

async function probe(label, launchOptions) {
  const out = { label, launched: false };
  let browser;
  try {
    browser = await chromium.launch(launchOptions);
    out.launched = true;
    out.version = browser.version();
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);

    const domains = await cdp.send("Schema.getDomains").catch(() => null);
    out.domains = domains ? domains.domains.map((d) => d.name).sort() : "Schema.getDomains unavailable";

    // 1. HeadlessExperimental.beginFrame -- advances the compositor by an exact
    //    delta and returns the screenshot from the same call. Ideal if present.
    out.beginFrame = await cdp
      .send("HeadlessExperimental.beginFrame", { frameTimeTicks: 0, interval: 16.667, noDisplayUpdates: false, screenshot: { format: "png" } })
      .then((r) => ({ ok: true, gotScreenshot: Boolean(r.screenshotData) }))
      .catch((e) => ({ ok: false, error: e.message.split("\n")[0] }));

    // 2. Emulation.setVirtualTimePolicy -- Blink-level virtual time. Drives
    //    timers, rAF and CSS animation together if it works.
    out.virtualTime = await cdp
      .send("Emulation.setVirtualTimePolicy", { policy: "pause" })
      .then((r) => ({ ok: true, virtualTimeTicksBase: r.virtualTimeTicksBase }))
      .catch((e) => ({ ok: false, error: e.message.split("\n")[0] }));

    // 3. Animation domain -- per-animation playback rate and seeking. The
    //    fallback for CSS animation if virtual time is unusable.
    out.animationDomain = await cdp
      .send("Animation.enable")
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: e.message.split("\n")[0] }));

    await browser.close();
  } catch (e) {
    out.error = e.message.split("\n")[0];
    if (browser) await browser.close().catch(() => {});
  }
  return out;
}

const results = [];
results.push(await probe("chromium (new headless)", { headless: true }));
results.push(await probe("chromium-headless-shell (old headless)", { headless: true, channel: "chromium-headless-shell" }));

for (const r of results) {
  console.log(`\n=== ${r.label} ===`);
  if (!r.launched) {
    console.log("  launch failed:", r.error);
    continue;
  }
  console.log("  version:        ", r.version);
  console.log("  beginFrame:     ", JSON.stringify(r.beginFrame));
  console.log("  virtualTime:    ", JSON.stringify(r.virtualTime));
  console.log("  animationDomain:", JSON.stringify(r.animationDomain));
  const interesting = Array.isArray(r.domains)
    ? r.domains.filter((d) => ["HeadlessExperimental", "Emulation", "Animation", "Page"].includes(d))
    : r.domains;
  console.log("  domains present:", JSON.stringify(interesting));
}
