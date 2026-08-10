/**
 * Rendering a Mockup: one template, laid out by the browser and photographed
 * once into a transparent image with a hole where the screen goes.
 *
 * The browser is the same `chrome-headless-shell` that captured the Frames, so
 * a template is CSS a person can open in a browser rather than drawing
 * instructions somebody has to reimplement. Where the aperture ends up is
 * measured off the laid-out document, so a template says where its screen goes
 * by putting an element there -- and the pipeline never learns the name of a
 * single one of them.
 *
 * Two passes, because a surround is as big as its own layout: the template is
 * laid out first to find out how large it is, and then photographed at exactly
 * that size so the image is the surround and nothing around it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect, type Cdp } from "./cdp.js";
import type { Viewport } from "./config.js";
import { launch, stop, type Launched } from "./driver.js";
import { RecordError } from "./errors.js";
import type { Mockup } from "./mockup.js";

/** Where the clip goes inside a rendered surround, in the image's own pixels. */
export type Aperture = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

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

export type RenderOptions = {
  readonly executable: string;
  /**
   * The Frames the surround is laid out around. Its CSS size is what the
   * template is given; its scale is what the image is rendered at, so the
   * aperture lands on whole captured pixels rather than between them.
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
  const profile = await mkdtemp(join(tmpdir(), "record-mockup-"));

  let browser: Launched;
  try {
    browser = await launch(options.executable, profile);
  } catch (failure) {
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    throw failure;
  }

  let cdp: Cdp;
  try {
    cdp = await connect(browser.wsUrl);
  } catch (failure) {
    await stop(browser.process, profile);
    throw failure;
  }

  try {
    // Photographed the way a Frame is photographed, by stepping the compositor:
    // the browser is launched with the switches that stop it drawing on its own
    // (ADR 0008), so asking it for a screenshot any other way is asking a
    // compositor that has been told to wait.
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      enableBeginFrameControl: true,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method: string, params?: Record<string, unknown>) =>
      cdp.send(method, params, sessionId as string);

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

    const loaded = cdp.once("Page.loadEventFired");
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

    return {
      name: mockup.name,
      image: Buffer.from(image, "base64"),
      width: width * scale,
      height: height * scale,
      aperture: aperture(mockup, placed.aperture, scale, width * scale, height * scale),
      backdrop: mockup.backdrop,
    };
  } finally {
    await cdp.send("Browser.close").catch(() => undefined);
    cdp.close();
    await stop(browser.process, profile);
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

/**
 * Where the clip goes, in the pixels of the image rather than the CSS pixels
 * the template was written in.
 *
 * An aperture reaching outside the surround is a template that would composite
 * the clip over the edge of its own image, so it is refused rather than
 * quietly cropped -- the Frames going missing is the failure this whole feature
 * would otherwise hide.
 */
function aperture(
  mockup: Mockup,
  measured: Rect,
  scale: number,
  width: number,
  height: number,
): Aperture {
  const placed = {
    x: Math.round(measured.x * scale),
    y: Math.round(measured.y * scale),
    width: Math.round(measured.width * scale),
    height: Math.round(measured.height * scale),
  };

  if (
    placed.width < 1 ||
    placed.height < 1 ||
    placed.x < 0 ||
    placed.y < 0 ||
    placed.x + placed.width > width ||
    placed.y + placed.height > height
  ) {
    throw new RecordError(
      `the '${mockup.name}' Mockup puts its aperture at ${placed.width}x${placed.height} ` +
        `at ${placed.x},${placed.y}, which is not inside its own ${width}x${height} surround`,
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
