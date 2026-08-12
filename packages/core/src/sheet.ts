/**
 * The contact sheet: every Mockup that ships, around one real Frame of a real
 * Project, rendered by the pipeline that records with them.
 *
 * It exists to be looked at -- a surround is chosen by eye, and a surround that
 * reads well on a web page can be unreadable at the width a README plays a GIF
 * at. It is also the evidence that the shipped presets share one code path:
 * every one of them is rendered by the same browser, measured the same way and
 * composited through the same filters as a Run's, so a preset that only worked
 * because something special was done for it would be visible here.
 *
 * The Frame is captured rather than taken out of an Artifact, because a Run
 * recorded inside a Mockup has that Mockup in its Artifacts already -- and a
 * surround wrapped around a surround is a picture of nothing.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { allParameters, effectiveParameters, loadAction } from "./action.js";
import type { Dimensions } from "./artifacts.js";
import { findHeadlessShell } from "./browser.js";
import { captureFrames, frameFile, type CapturedFrames } from "./capture.js";
import { actionModule, readProject, type Viewport } from "./config.js";
import { cursorOverlay, cursorSettings } from "./cursor.js";
import { compositeFrame } from "./encode.js";
import { RecordError } from "./errors.js";
import { historyDirectory } from "./history.js";
import { ensureRunning } from "./lifecycle.js";
import { mockups, noMockup } from "./mockup.js";
import { readOverrides } from "./overrides.js";
import { renderMockup, writeMockup } from "./render.js";
import { textSubstitution } from "./text.js";
import { evaluateTimeline } from "./timeline.js";

/** One preset as the sheet rendered it. */
export type SheetEntry = {
  readonly mockup: string;
  readonly describes: string;
  /** What the surround was composited onto, and nothing for the bare Frame. */
  readonly backdrop?: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
};

/** Every preset around one Frame, and where they were written. */
export type ContactSheetReport = {
  readonly project: string;
  readonly action: string;
  /** How far into the Action the Frame was taken from, in seconds. */
  readonly at: number;
  /** Which Frame of the Timeline that came to. */
  readonly frame: number;
  readonly directory: string;
  /** The page showing every rendering at once, which is the sheet itself. */
  readonly page: string;
  readonly mockups: readonly SheetEntry[];
};

export type ContactSheetOptions = {
  /** How far into the Action to photograph, in seconds. The first Frame by default. */
  readonly at?: number;
};

/** Where a contact sheet is written: beside the Runs, and never among them. */
export function sheetDirectory(workspace: string, project: string, action: string): string {
  return join(historyDirectory(workspace, project, action), "mockups");
}

/**
 * Renders every Mockup around one Frame of an Action, and the page that shows
 * them together.
 *
 * The Frame is photographed exactly as a Run photographs one -- the same
 * Timeline, the same drawn cursor, the same replacement copy -- and then put
 * inside each preset in turn. What it is not put inside is a Mockup: the Frame
 * the sheet compares is the undecorated one, whatever the Project chose.
 */
export async function renderContactSheet(
  workspace: string,
  projectName: string,
  actionName: string,
  options: ContactSheetOptions = {},
): Promise<ContactSheetReport> {
  const project = await readProject(workspace, projectName);
  const action = await loadAction(await actionModule(workspace, projectName, actionName));

  const effective = effectiveParameters(
    allParameters(action, project),
    await readOverrides(workspace, projectName, actionName),
  );

  const timeline = action.timeline(effective.values);
  const states = evaluateTimeline(timeline);
  if (states.length === 0) {
    throw new RecordError(`'${actionName}' declares a Timeline that produces no Frames`);
  }

  const at = options.at ?? 0;
  if (!Number.isFinite(at) || at < 0) {
    throw new RecordError(`${at} is not an instant of the clip to photograph`);
  }

  // The Frame the asked-for instant lands on, and the last one for an instant
  // past the end -- an instant outside the clip is an instant nothing was
  // recorded at, and the end of the clip is the nearest thing there is to it.
  const frame = Math.min(states.length - 1, Math.round(at * timeline.framerate));

  const directory = sheetDirectory(workspace, projectName, actionName);
  const frames = join(directory, "frames");
  await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  await mkdir(directory, { recursive: true });

  const executable = await findHeadlessShell();
  const cursor = cursorSettings(effective.values, timeline);
  const overlay = cursorOverlay(cursor);
  const substitution = textSubstitution(action.text ?? {});

  const running = await ensureRunning(project);

  let photograph: CapturedFrames;
  try {
    // Driven from the first Frame to the one being photographed, because a
    // Frame of a Timeline is what the Frames before it left the page as.
    photograph = await captureFrames({
      url: project.baseUrl,
      executable,
      viewport: project.viewport,
      framerate: timeline.framerate,
      states: states.slice(0, frame + 1),
      directory: frames,
      ...(overlay === undefined ? {} : { overlay }),
      ...(substitution === undefined ? {} : { substitution }),
    });
  } finally {
    await running.stop();
  }

  const photographed = join(frames, frameFile(frame));
  // The Frame's own size, as capture read it off the image: what the viewport
  // asked to be rendered at is not what the browser hands back.
  const captured: Dimensions = photograph.size;

  const rendered: SheetEntry[] = [];

  for (const name of [noMockup, ...Object.keys(mockups)]) {
    rendered.push(
      await around(name, {
        frame: photographed,
        captured,
        width: project.videoWidth,
        into: directory,
        executable,
        viewport: project.viewport,
      }),
    );
  }

  const page = join(directory, "contact-sheet.html");
  await writeFile(page, sheetPage(projectName, actionName, rendered), "utf8");

  // The Frame was only ever the thing every preset is compared around, and it
  // is a Frame of the Project: it goes the way a Run's Frames go.
  await rm(frames, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);

  return {
    project: projectName,
    action: actionName,
    at,
    frame,
    directory,
    page,
    mockups: rendered,
  };
}

/** One Frame inside one preset, written where the sheet can show it. */
async function around(
  name: string,
  photographed: {
    frame: string;
    captured: Dimensions;
    width: number;
    into: string;
    executable: string;
    viewport: Viewport;
  },
): Promise<SheetEntry> {
  const image = join(photographed.into, `${name}.png`);
  const mockup = mockups[name];

  if (mockup === undefined) {
    const size = await compositeFrame({
      frame: photographed.frame,
      captured: photographed.captured,
      width: photographed.width,
      file: image,
    });

    return {
      mockup: name,
      describes: "The Frames exactly as captured, and nothing around them",
      image,
      ...size,
    };
  }

  const rendered = await renderMockup(mockup, {
    executable: photographed.executable,
    viewport: photographed.viewport,
  });
  const surround = await writeMockup(rendered, join(photographed.into, `${name}.surround.png`));

  const size = await compositeFrame({
    frame: photographed.frame,
    captured: photographed.captured,
    mockup: surround,
    width: photographed.width,
    file: image,
  });

  // The rendered surround was the means rather than the point; what the sheet
  // is looked at for is the clip inside it.
  await rm(surround.image, { force: true, maxRetries: 5 }).catch(() => undefined);

  return {
    mockup: name,
    describes: mockup.describes,
    backdrop: mockup.backdrop,
    image,
    ...size,
  };
}

/**
 * The sheet itself: one page, no build step and no external request, showing
 * every preset at the width the Project's video Artifacts are encoded at.
 */
function sheetPage(project: string, action: string, entries: readonly SheetEntry[]): string {
  const figures = entries
    .map((entry) =>
      [
        "<figure>",
        `<figcaption><strong>${escaped(entry.mockup)}</strong>`,
        `<span>${escaped(entry.describes)}</span>`,
        `<span>${entry.width}&times;${entry.height}` +
          `${entry.backdrop === undefined ? "" : ` on ${escaped(entry.backdrop)}`}</span>`,
        "</figcaption>",
        `<img alt="${escaped(action)} inside the ${escaped(entry.mockup)} Mockup" ` +
          `src="${escaped(entry.mockup)}.png">`,
        "</figure>",
      ].join(""),
    )
    .join("");

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>record — Mockups around ${escaped(project)} ${escaped(action)}</title>`,
    "<style>",
    "*{box-sizing:border-box}",
    "body{margin:0;padding:28px;background:#fff;color:#18181b;",
    'font:14px/1.45 "Segoe UI",system-ui,-apple-system,sans-serif}',
    "h1{margin:0 0 6px;font-size:17px}",
    "p{margin:0 0 24px;color:#5f5f6a;max-width:78ch}",
    "figure{margin:0 0 36px}",
    "figcaption{margin-bottom:10px}",
    "figcaption span{display:block;color:#5f5f6a;max-width:70ch}",
    "img{display:block;max-width:100%;height:auto}",
    "</style></head><body>",
    `<h1>Mockups — ${escaped(project)} ${escaped(action)}</h1>`,
    "<p>Every Mockup that ships, around one Frame of this Action, at the width this " +
      "Project's video Artifacts are encoded at. Judge each one at the width a README " +
      "plays a GIF at as well: a surround that reads well large can leave the clip " +
      "inside it unreadable small.</p>",
    figures,
    "</body></html>",
  ].join("");
}

/** Written into a page, so a Mockup named with a bracket stays a name. */
function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
