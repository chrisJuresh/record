/**
 * Rendering a Mockup: one template, laid out by the browser and photographed
 * once into a transparent image with its Aperture cut through it.
 *
 * The browser is the same `chrome-headless-shell` that captured the Frames, so
 * a template is CSS a person can open in a browser rather than drawing
 * instructions somebody has to reimplement. Where the Aperture ends up is
 * measured off the laid-out document, so a template says where the clip goes by
 * putting an element there -- and the pipeline never learns the name of a
 * single one of them.
 *
 * Two passes, because a surround is as big as its own layout: the template is
 * laid out first to find out how large it is, and then photographed at exactly
 * that size so the image is the surround and nothing around it.
 *
 * How large the resulting image is, though, is the browser's answer rather than
 * this tool's: it is measured off the PNG and the Aperture is scaled by what
 * that comes to. The alternative -- multiplying the layout by the device scale
 * factor the viewport asked for -- is arithmetic that agrees only with itself,
 * and it laid every surround over a quarter of its own canvas for as long as a
 * Project was configured at any scale but 1.
 */
import { writeFile } from "node:fs/promises";

import type { Dimensions } from "./artifacts.js";
import type { Viewport } from "./config.js";
import { openPage } from "./driver.js";
import { RecordError } from "./errors.js";
import type { Aperture, Mockup } from "./mockup.js";
import { pngDimensions } from "./png.js";

/** One Mockup as it was rendered, ready to be composited around a clip. */
export type RenderedMockup = {
  readonly name: string;
  /** The transparent PNG, in the image's own pixels. */
  readonly image: Buffer;
  readonly width: number;
  readonly height: number;
  readonly aperture: Aperture;
  /** The colour everything the template left transparent is composited onto. */
  readonly backdrop: string;
};

/**
 * A rendered Mockup as the encoder composites a clip into it: the same surround
 * once it is a file ffmpeg can read rather than bytes in hand.
 */
export type Composite = Omit<RenderedMockup, "name" | "image"> & {
  readonly image: string;
};

/**
 * Writes a rendered surround where the encoder can read it. Both the Runs and
 * the contact sheet composite from a file, because ffmpeg reads files.
 */
export async function writeMockup(rendered: RenderedMockup, file: string): Promise<Composite> {
  await writeFile(file, rendered.image);

  return {
    image: file,
    width: rendered.width,
    height: rendered.height,
    aperture: rendered.aperture,
    backdrop: rendered.backdrop,
  };
}

export type RenderOptions = {
  readonly executable: string;
  /**
   * The Frames the surround is laid out around. Its CSS size is what the
   * template is given, and its scale is what the browser is launched to render
   * at -- but what the image came out at is still measured rather than
   * multiplied out, because the size of a surround is the browser's answer.
   */
  readonly viewport: Viewport;
};

/** How much larger than the clip a surround is allowed to lay itself out. */
const roomToLayOut = 3;

/**
 * Frames driven before the surround is photographed. The compositor reports no
 * damage until it has painted, so the first of them returns no image at all --
 * the same reason capture primes the page it is about to record (ADR 0008).
 */
const primingFrames = 3;

export async function renderMockup(
  mockup: Mockup,
  options: RenderOptions,
): Promise<RenderedMockup> {
  const scale = options.viewport.deviceScaleFactor;
  const clip = { width: options.viewport.width, height: options.viewport.height };

  // The same browser under the same switches as capture (ADR 0008), which also
  // means the surround is photographed the way a Frame is: by stepping the
  // compositor, because this browser has been told not to draw on its own. At
  // the same scale, too, so that a surround is as dense as the Frames it is
  // laid around -- what that comes to is still measured off the image rather
  // than assumed from it.
  const page = await openPage(options.executable, scale);

  try {
    const send = page.send;

    await send("Page.enable");
    await send("Runtime.enable");

    // What makes the image a surround rather than a picture of a white page:
    // everything the template does not paint stays transparent, and is filled
    // with the Mockup's backdrop when the clip is composited into it.
    await send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });

    const size = async (width: number, height: number) =>
      send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: scale,
        mobile: false,
      });

    // Room enough for any surround to lay itself out at its natural size, which
    // is what the first pass is for.
    await size(clip.width * roomToLayOut, clip.height * roomToLayOut);

    const loaded = page.once("Page.loadEventFired");
    const navigation = await send("Page.navigate", { url: documentUrl(mockup, clip) });
    if (typeof navigation["errorText"] === "string") {
      throw new RecordError(
        `the '${mockup.name}' Mockup did not lay out: ${navigation["errorText"]}`,
      );
    }
    await loaded;

    const laidOut = measured(mockup, await send("Runtime.evaluate", { expression: measure, returnByValue: true }));
    const width = Math.ceil(laidOut.surround.width);
    const height = Math.ceil(laidOut.surround.height);

    // Photographed at exactly the size it laid out to, so the image is the
    // surround: no page around it, and nothing of it cut off.
    await size(width, height);

    const placed = measured(mockup, await send("Runtime.evaluate", { expression: measure, returnByValue: true }));

    let image: string | undefined;
    for (let frame = 0; frame < primingFrames; frame++) {
      const drawn = await send("HeadlessExperimental.beginFrame", {
        noDisplayUpdates: false,
        screenshot: { format: "png" },
      });

      // A Frame the compositor reports as undamaged returns no image, which for
      // a surround that never moves is every Frame after the one that drew it.
      if (typeof drawn["screenshotData"] === "string") {
        image = drawn["screenshotData"];
      }
    }

    if (image === undefined) {
      throw new RecordError(
        `the '${mockup.name}' Mockup had still not painted after ${primingFrames} Frames`,
      );
    }

    const bytes = Buffer.from(image, "base64");
    const drawn = pngDimensions(bytes, `the '${mockup.name}' Mockup`);

    return {
      name: mockup.name,
      image: bytes,
      width: drawn.width,
      height: drawn.height,
      aperture: aperture(mockup, placed.aperture, drawnAt(mockup, drawn, { width, height }), drawn),
      backdrop: mockup.backdrop,
    };
  } finally {
    await page.close();
  }
}

/** The template, as a document the browser can be pointed at without a server. */
function documentUrl(mockup: Mockup, clip: { width: number; height: number }): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(mockup.document(clip))}`;
}

/** One laid-out rectangle, as the page reports it in CSS pixels. */
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/**
 * What the laid-out template amounts to: how much room the surround takes, and
 * where in it the aperture ended up. Asked of the page, because where a
 * template puts its aperture is CSS rather than arithmetic agreed in advance.
 */
const measure = `
  (() => {
    const box = (element) => {
      if (element === null) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    return {
      surround: box(document.querySelector("[data-record-mockup]")),
      aperture: box(document.querySelector("[data-record-aperture]")),
    };
  })()
`;

/** What the page answered, or a failure naming the template that answered nothing. */
function measured(
  mockup: Mockup,
  evaluated: Record<string, unknown>,
): { surround: Rect; aperture: Rect } {
  const exception = evaluated["exceptionDetails"] as { text?: string } | undefined;
  if (exception !== undefined) {
    throw new RecordError(
      `the '${mockup.name}' Mockup could not be measured: ${exception.text ?? "unknown"}`,
    );
  }

  const answer = (evaluated["result"] as { value?: unknown } | undefined)?.value as
    | { surround?: Rect | null; aperture?: Rect | null }
    | undefined;

  const surround = answer?.surround;
  const aperture = answer?.aperture;

  if (!isRect(surround)) {
    throw new RecordError(
      `the '${mockup.name}' Mockup declares no surround, which is one element marked data-record-mockup`,
    );
  }
  if (!isRect(aperture)) {
    throw new RecordError(
      `the '${mockup.name}' Mockup declares no aperture, which is one element marked data-record-aperture`,
    );
  }

  return { surround, aperture };
}

/** How far a surround's rendered image is off the layout it was measured in. */
const scaleTolerance = 0.01;

/**
 * What the image came out at against the layout it was photographed from, as
 * one factor -- which is what the Aperture measured in CSS pixels has to be
 * multiplied by to land on the image.
 *
 * An image that is not a uniform scaling of its own layout is refused. The
 * check that was here compared the Aperture against a surround size derived
 * from the same multiplication, so it could only ever agree with itself: a
 * surround half the size the pipeline believed it was passed, and was then laid
 * over a quarter of the canvas.
 */
function drawnAt(mockup: Mockup, drawn: Dimensions, laidOut: Dimensions): number {
  const across = drawn.width / laidOut.width;
  const down = drawn.height / laidOut.height;

  if (Math.abs(across - down) > scaleTolerance) {
    throw new RecordError(
      `the '${mockup.name}' Mockup laid out at ${laidOut.width}x${laidOut.height} and was drawn ` +
        `${drawn.width}x${drawn.height}, which is not the same surround at one scale`,
    );
  }

  return across;
}

/**
 * Where the clip goes, in the pixels of the image rather than the CSS pixels
 * the template was written in.
 *
 * An aperture reaching outside the surround is a template that would composite
 * the clip over the edge of its own image, so it is refused rather than
 * quietly cropped -- the Frames going missing is the failure this whole feature
 * would otherwise hide.
 */
function aperture(mockup: Mockup, laidOut: Rect, scale: number, drawn: Dimensions): Aperture {
  const placed = {
    x: Math.round(laidOut.x * scale),
    y: Math.round(laidOut.y * scale),
    width: Math.round(laidOut.width * scale),
    height: Math.round(laidOut.height * scale),
  };

  if (
    placed.width < 1 ||
    placed.height < 1 ||
    placed.x < 0 ||
    placed.y < 0 ||
    placed.x + placed.width > drawn.width ||
    placed.y + placed.height > drawn.height
  ) {
    throw new RecordError(
      `the '${mockup.name}' Mockup puts its aperture at ${placed.width}x${placed.height} ` +
        `at ${placed.x},${placed.y}, which is not inside its own ` +
        `${drawn.width}x${drawn.height} surround`,
    );
  }

  return placed;
}

function isRect(value: unknown): value is Rect {
  const rect = value as Rect | null | undefined;

  return (
    rect !== null &&
    rect !== undefined &&
    ["x", "y", "width", "height"].every((key) => typeof (rect as Record<string, unknown>)[key] === "number")
  );
}
