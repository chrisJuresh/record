// Does one beginFrame advance the page's own animation by exactly one frame?
//
// This is the question ADR 0001 stands or falls on. The fixture animates the
// same 0 -> 600px linear ramp over 1000ms four different ways: a CSS
// transition, CSS keyframes, a requestAnimationFrame loop, and a setTimeout.
// If the clock drives all of them coherently, every frame lands on the expected
// value and two independent runs agree byte for byte.
//
// Two modes are compared, because beginFrame alone drives the compositor clock
// but not the timer queue.
import { createHash } from "node:crypto";
import { openBeginFrame } from "./cdp.mjs";
import { measure } from "./measure.mjs";

const FPS = 60;
const FRAME_MS = 1000 / FPS;
const FRAMES = 72; // 1.2s -- past the end of the 1s ramps
const FIXTURE = new URL("./fixture.html", import.meta.url).href;

async function run(advanceTimers) {
  const s = await openBeginFrame(FIXTURE, { width: 800, height: 400, fps: FPS, advanceTimers });
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    const buf = await s.next();
    frames.push({ i, hash: createHash("sha256").update(buf).digest("hex").slice(0, 12), ...measure(buf) });
  }
  frames.primed = s.primed;
  await s.close();
  return frames;
}

async function assess(label, advanceTimers) {
  const a = await run(advanceTimers);
  const b = await run(advanceTimers);

  // Priming frames also advance the animation, so frame i has had (i + primed)
  // frames of motion behind it.
  const expected = (i) => Math.min(((i + a.primed) * FRAME_MS) / 1000, 1) * 600;

  let maxDrift = 0;
  let worst = "";
  let coherence = 0;
  for (const f of a) {
    for (const key of ["transition", "keyframes", "raf"]) {
      const drift = Math.abs(f[key] - expected(f.i));
      if (drift > maxDrift) {
        maxDrift = drift;
        worst = `frame ${f.i} ${key}: ${f[key]}px vs ${expected(f.i).toFixed(1)}px`;
      }
    }
    coherence = Math.max(coherence, Math.abs(f.transition - f.raf), Math.abs(f.keyframes - f.raf));
  }

  const identical = a.every((f, i) => f.hash === b[i].hash);
  const timerA = a.findIndex((f) => f.timerFired);
  const timerB = b.findIndex((f) => f.timerFired);
  const timerExpected = Math.round(500 / FRAME_MS - a.primed);

  console.log(`\n=== ${label} ===`);
  console.log("  priming frames:                  ", a.primed, "/", b.primed, a.primed === b.primed ? "(stable)" : "(UNSTABLE)");
  console.log("  divergence between mechanisms:   ", coherence.toFixed(1), "px");
  console.log("  drift from the expected ramp:    ", maxDrift.toFixed(1), "px", maxDrift > 1 ? `(${worst})` : "");
  console.log("  setTimeout(500ms) fired at frame:", timerA, `(expected ~${timerExpected})`, timerA === timerB ? "stable" : "UNSTABLE");
  console.log("  two runs byte-identical:         ", identical);

  const timersOk = timerA >= 0 && timerA === timerB && Math.abs(timerA - timerExpected) <= 2;
  const ok = identical && a.primed === b.primed && coherence <= 1 && maxDrift <= 1;
  console.log("  ->", ok ? "compositor clock: PASS" : "compositor clock: FAIL", "|", timersOk ? "timer queue: PASS" : "timer queue: FAIL");
  return ok && timersOk;
}

const withoutTimers = await assess("beginFrame only", false);
const withTimers = await assess("beginFrame + virtual time", true);

console.log("\nRESULT:", withTimers ? "PASS -- ADR 0001 is sound" : withoutTimers ? "PARTIAL" : "FAIL");
process.exit(withTimers ? 0 : 1);
