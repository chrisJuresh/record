// Only 43 of 171 frames were distinct. Is the site quantising our scroll
// position, or is the easing simply moving sub-pixel amounts near the ends?
import { openBeginFrame } from "./cdp.mjs";

const FPS = 60, FRAME_MS = 1000 / FPS;
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

const s = await openBeginFrame("http://127.0.0.1:8770/", { width: 1440, height: 900, fps: FPS, advanceTimers: true, deviceScaleFactor: 2 });
const evaluate = async (e) => (await s.send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
await evaluate(`(() => { const st = document.createElement("style"); st.textContent = "*,html,body{scroll-behavior:auto !important}"; document.head.appendChild(st); })()`);
await evaluate(`window.__scroller = document.scrollingElement || document.documentElement`);
for (let i = 0; i < 60; i++) await s.next();

const rows = [];
for (let i = 0; i < FRAMES; i++) {
  const want = scrollAt(i * FRAME_MS);
  const got = await evaluate(`(() => { window.__scroller.scrollTop = ${want}; return window.__scroller.scrollTop; })()`);
  await s.next();
  rows.push({ i, want: +want.toFixed(2), got });
}
await s.close();

const distinctWanted = new Set(rows.map((r) => r.want.toFixed(2))).size;
const distinctGot = new Set(rows.map((r) => r.got)).size;
const quantum = [...new Set(rows.map((r) => r.got))].sort((a, b) => a - b);
const steps = quantum.slice(1).map((v, i) => +(v - quantum[i]).toFixed(3));

console.log("distinct positions requested:", distinctWanted, "of", FRAMES, "frames");
console.log("distinct positions applied:  ", distinctGot);
console.log("applied step sizes (px):     ", [...new Set(steps)].sort((a, b) => a - b).join(", "));
console.log("\nsample (frame: requested -> applied)");
for (const r of rows.filter((r) => r.i >= 24 && r.i <= 44)) console.log(`  ${String(r.i).padStart(3)}: ${String(r.want).padStart(7)} -> ${r.got}`);
