// The scroll-peek Action, captured against the real photos site.
//
// Proves the second half of ADR 0001: that a real, image-heavy application
// captures deterministically, not just a synthetic fixture.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openBeginFrame } from "./cdp.mjs";

const URL_UNDER_TEST = "http://127.0.0.1:8770/";
const FPS = 60;
const FRAME_MS = 1000 / FPS;
const DPR = 2;
const VIEWPORT = { width: 1440, height: 900 };

// hold 400 | ease down 180px over 900 | hold 250 | ease back over 900 | hold 400
const HOLD_IN = 400, TRAVEL = 900, DISTANCE = 180, HOLD_MID = 250, HOLD_OUT = 400;
const TOTAL_MS = HOLD_IN + TRAVEL + HOLD_MID + TRAVEL + HOLD_OUT;
const FRAMES = Math.round(TOTAL_MS / FRAME_MS);

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function scrollAt(ms) {
  if (ms < HOLD_IN) return 0;
  if (ms < HOLD_IN + TRAVEL) return DISTANCE * easeInOutCubic((ms - HOLD_IN) / TRAVEL);
  if (ms < HOLD_IN + TRAVEL + HOLD_MID) return DISTANCE;
  if (ms < HOLD_IN + TRAVEL + HOLD_MID + TRAVEL) return DISTANCE * (1 - easeInOutCubic((ms - HOLD_IN - TRAVEL - HOLD_MID) / TRAVEL));
  return 0;
}

// The page may scroll the window or an inner container. Find whichever actually
// scrolls, once, and drive that.
const FIND_SCROLLER = `
  (() => {
    const de = document.scrollingElement || document.documentElement;
    if (de.scrollHeight > de.clientHeight + 4) { window.__scroller = de; return "document"; }
    let best = null, bestOverflow = 0;
    for (const el of document.querySelectorAll("*")) {
      const overflow = el.scrollHeight - el.clientHeight;
      const style = getComputedStyle(el);
      const scrollable = /(auto|scroll)/.test(style.overflowY);
      if (scrollable && overflow > bestOverflow) { best = el; bestOverflow = overflow; }
    }
    window.__scroller = best || de;
    return best ? (best.tagName + "." + (best.className || "").toString().split(" ")[0] + " overflow=" + bestOverflow) : "document(fallback)";
  })()
`;

async function run(label, outDir) {
  const s = await openBeginFrame(URL_UNDER_TEST, { ...VIEWPORT, fps: FPS, advanceTimers: true, deviceScaleFactor: DPR });
  const evaluate = async (expression) =>
    (await s.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

  // Smooth-scroll CSS would fight frame-exact positioning.
  await evaluate(`
    (() => { const st = document.createElement("style");
      st.textContent = "*,html,body{scroll-behavior:auto !important}";
      document.head.appendChild(st); })()
  `);

  const scroller = await evaluate(FIND_SCROLLER);

  // Let images load and any intro animation finish before the clip starts.
  for (let i = 0; i < 60; i++) await s.next();
  const settled = await evaluate(
    `({ images: document.images.length, complete: [...document.images].filter(i => i.complete).length, height: window.__scroller.scrollHeight })`,
  );

  mkdirSync(outDir, { recursive: true });
  const hashes = [];
  for (let i = 0; i < FRAMES; i++) {
    await evaluate(`window.__scroller.scrollTop = ${scrollAt(i * FRAME_MS)}`);
    const buf = await s.next();
    writeFileSync(join(outDir, `f${String(i).padStart(4, "0")}.png`), buf);
    hashes.push(createHash("sha256").update(buf).digest("hex").slice(0, 12));
  }
  const repeated = s.repeatedFrames;
  await s.close();
  return { label, scroller, settled, hashes, repeated };
}

const outA = new URL("./out/run-a", import.meta.url).pathname.slice(1);
const outB = new URL("./out/run-b", import.meta.url).pathname.slice(1);
rmSync(new URL("./out", import.meta.url).pathname.slice(1), { recursive: true, force: true });

const a = await run("A", outA);
const b = await run("B", outB);

const diffs = a.hashes.map((h, i) => (h === b.hashes[i] ? null : i)).filter((i) => i !== null);
const distinct = new Set(a.hashes).size;

console.log("scroll container:      ", a.scroller);
console.log("images on page:        ", `${a.settled.complete}/${a.settled.images} complete`, "| scrollHeight", a.settled.height);
console.log("frames captured:       ", FRAMES, `(${TOTAL_MS}ms at ${FPS}fps)`);
console.log("distinct frames in A:  ", distinct, `(${FRAMES - distinct} repeats -- expected during the holds)`);
console.log("undamaged frames:      ", a.repeated, "/", b.repeated);
console.log("frames differing A vs B:", diffs.length, diffs.length ? `first at ${diffs[0]}` : "");
console.log("\nRESULT:", diffs.length === 0 ? "PASS -- a real site captures deterministically" : "FAIL");
process.exit(diffs.length === 0 ? 0 : 1);
