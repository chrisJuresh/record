/**
 * Mockups: the decorative surround composited around the captured Frames.
 *
 * A Mockup is an HTML/CSS template rendered once, by the same browser that
 * captured the Frames, into a transparent image with an Aperture cut through
 * it. The Frames are then composited into that Aperture. Nothing about a Mockup
 * is drawn into the page, because a surround is not something the page does --
 * and drawing it into the page would put it inside the Frames, where the clip
 * could scroll underneath it.
 *
 * The templates are a registry. Adding a Mockup is adding an entry: the
 * pipeline names no template, measures every aperture the same way, and
 * composites every surround through one filter -- which is what the contact
 * sheet renders every preset to demonstrate.
 *
 * A template says where its aperture is by marking one element with
 * `data-record-aperture` and leaving it transparent, which it does by filling
 * everything around it with a spread shadow rather than painting a background
 * behind it. Everything outside the surround's own silhouette is transparent
 * too, and is filled at composite time with the Mockup's declared backdrop.
 *
 * Silhouettes are generic rather than modelled on identifiable hardware,
 * because Published clips are public.
 */
import type { Dimensions } from "./artifacts.js";
import type { ColourScheme } from "./capture.js";
import { RecordError } from "./errors.js";
import { nameSetting, type Settled } from "./settings.js";

/** One decorative surround: what it is for, what it sits on, and how it is drawn. */
export type Mockup = {
  readonly name: string;
  /** Read by the person choosing one, so it says what the surround costs. */
  readonly describes: string;
  /**
   * The colour everything the template leaves transparent is composited onto,
   * as `#rrggbb`. A surround is drawn to sit on something, and its own shadow
   * is only a shadow against the thing it falls on.
   */
  readonly backdrop: string;
  /**
   * The surround as a whole document, laid out around a clip of this size in
   * CSS pixels. Where the aperture ends up is the template's business and is
   * measured rather than declared, so a template is CSS rather than arithmetic
   * the pipeline has to agree with.
   */
  document(clip: Dimensions): string;
};

/** The Frames as captured, with nothing composited around them. */
export const noMockup = "none";

/**
 * Chosen by the page rather than declared: a dark page gets the dark browser
 * window and everything else gets the light one, so a Project that was never
 * configured still gets the surround it would have been given.
 */
export const automaticMockup = "auto";

/** What a surround sits on: the page a clip is likely to be read on. */
const neutralBackdrop = "#f4f4f5";
const darkBackdrop = "#0d1117";

/**
 * The Mockups that ship. Each is one entry and nothing else -- a sixth is
 * written here and is immediately selectable, because nothing outside this
 * registry names a template.
 */
export const mockups: Readonly<Record<string, Mockup>> = {
  rounded: {
    name: "rounded",
    describes: "Corners and a shadow, and no surround at all -- the cheapest thing that is not nothing",
    backdrop: neutralBackdrop,
    document: (clip) => roundedDocument(clip, neutralBackdrop),
  },
  "browser-light": {
    name: "browser-light",
    describes: "A generic light browser window: three lights and an empty address pill",
    backdrop: neutralBackdrop,
    document: (clip) => browserDocument(clip, lightChrome),
  },
  "browser-dark": {
    name: "browser-dark",
    describes: "The same window in dark, for a Project that renders dark",
    backdrop: darkBackdrop,
    document: (clip) => browserDocument(clip, darkChrome),
  },
  laptop: {
    name: "laptop",
    describes: "A generic lid and base. Costs the most room, so judge it at GIF width",
    backdrop: neutralBackdrop,
    document: (clip) => laptopDocument(clip),
  },
  phone: {
    name: "phone",
    describes:
      "A generic handset, portrait -- a clip wider than it is centre-cropped, so record at a " +
      "phone viewport to fill it",
    backdrop: neutralBackdrop,
    document: (clip) => phoneDocument(clip),
  },
};

/** Every Mockup a Project or an Action may be set to, in the order they are offered. */
export const mockupNames: readonly string[] = [
  automaticMockup,
  noMockup,
  ...Object.keys(mockups),
];

/** The Mockup Parameter every Action carries, defaulting to the Project's own choice. */
export function mockupParameters(chosen: string): {
  readonly mockup: {
    readonly kind: "choice";
    readonly describes: string;
    readonly default: string;
    readonly choices: readonly string[];
  };
} {
  return {
    mockup: {
      kind: "choice",
      describes: "The surround composited around the Frames",
      default: chosen,
      choices: mockupNames,
    },
  };
}

/** Which Mockup a Run was asked for, before the page has had its say. */
export function mockupAsked(values: Settled): string {
  return nameSetting(values, "mockup");
}

/**
 * The Mockup a Run composites with, or nothing at all where it composites
 * nothing -- which leaves the Artifacts exactly as they would have been encoded
 * without the feature rather than passing them through a surround that happens
 * to be empty.
 *
 * `auto` is answered by the page: a page that paints itself dark is one the
 * light window would glow around. A page with nothing to say about it is light,
 * because that is what a browser shows a page that never asked.
 */
export function mockupFor(asked: string, scheme: ColourScheme): Mockup | undefined {
  const name = asked === automaticMockup ? automatic(scheme) : asked;

  if (name === noMockup) {
    return undefined;
  }

  const mockup = mockups[name];
  if (mockup === undefined) {
    throw new RecordError(`'${name}' is not a Mockup. There is ${mockupNames.join(", ")}`);
  }
  return mockup;
}

/** Which window a page that never declared one is shown in. */
function automatic(scheme: ColourScheme): string {
  return scheme === "dark" ? "browser-dark" : "browser-light";
}

/** A fraction of the clip's width, in whole pixels and never smaller than this. */
function scaled(clip: Dimensions, fraction: number, least: number): number {
  return Math.max(least, Math.round(clip.width * fraction));
}

/**
 * One template as a whole document. Everything shares this frame: no external
 * request, no text, and a transparent page -- what a template contributes is a
 * silhouette and an aperture, and the two together are all the pipeline reads.
 */
function template(style: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>Mockup</title><style>',
    "*{box-sizing:border-box;margin:0;padding:0}",
    "html,body{background:transparent}",
    "body{width:max-content}",
    // How every Aperture is cut: a spread far enough to reach the edge of any
    // canvas a clip could be laid out on, so the surround is filled around the
    // Aperture rather than painted behind it -- a background behind the
    // Aperture is a surround the clip cannot be seen through. A template
    // wanting a shadow cast from the Aperture itself sets --cast.
    ".fills{box-shadow:var(--cast,0 0 0 rgba(0,0,0,0)),0 0 0 9999px var(--fill)}",
    style,
    "</style></head><body>",
    body,
    "</body></html>",
  ].join("");
}

/** The soft shadow every surround but `none` casts onto its backdrop. */
function shadow(clip: Dimensions): string {
  const near = scaled(clip, 0.004, 1);
  const far = scaled(clip, 0.032, 4);

  return `0 ${near}px ${near * 2}px rgba(0,0,0,.10), 0 ${Math.round(far / 2)}px ${far}px rgba(0,0,0,.18)`;
}

function roundedDocument(clip: Dimensions, backdrop: string): string {
  const margin = scaled(clip, 0.03, 6);
  const radius = scaled(clip, 0.014, 3);

  return template(
    [
      `#mockup{padding:${margin}px}`,
      `#aperture{--fill:${backdrop};--cast:${shadow(clip)};width:${clip.width}px;` +
        `height:${clip.height}px;border-radius:${radius}px}`,
    ].join(""),
    '<div id="mockup" data-record-mockup><div id="aperture" data-record-aperture class="fills"></div></div>',
  );
}

/** What tells one browser window from the other, which is every colour and nothing else. */
type Chrome = {
  readonly bar: string;
  readonly line: string;
  readonly light: string;
  readonly address: string;
  readonly addressLine: string;
};

const lightChrome: Chrome = {
  bar: "#e9e9ec",
  line: "#d7d7dc",
  light: "#c4c4cb",
  address: "#f7f7f9",
  addressLine: "#d7d7dc",
};

const darkChrome: Chrome = {
  bar: "#26262c",
  line: "#35353d",
  light: "#4a4a55",
  address: "#1c1c21",
  addressLine: "#35353d",
};

/**
 * A window with a titlebar and no tab strip, no logo and no wording: an empty
 * address pill says "a browser" without claiming to be one anybody could name,
 * and without inviting the question of what URL a local Project would show.
 */
function browserDocument(clip: Dimensions, chrome: Chrome): string {
  const margin = scaled(clip, 0.03, 6);
  const radius = scaled(clip, 0.012, 4);
  const bar = scaled(clip, 0.036, 10);
  const light = scaled(clip, 0.0092, 2);
  const gap = scaled(clip, 0.006, 1);
  const pad = scaled(clip, 0.013, 3);
  const address = scaled(clip, 0.019, 4);

  return template(
    [
      `#mockup{padding:${margin}px}`,
      `#window{position:relative;width:${clip.width}px;border-radius:${radius}px;` +
        `overflow:hidden;box-shadow:${shadow(clip)}}`,
      `#bar{position:relative;z-index:2;display:flex;align-items:center;gap:${gap * 2}px;` +
        `height:${bar}px;padding:0 ${pad}px;background:${chrome.bar};` +
        `border-bottom:1px solid ${chrome.line}}`,
      `#lights{display:flex;gap:${gap}px}`,
      `#lights i{display:block;width:${light}px;height:${light}px;border-radius:50%;background:${chrome.light}}`,
      `#address{flex:0 1 46%;height:${address}px;border-radius:999px;background:${chrome.address};` +
        `border:1px solid ${chrome.addressLine}}`,
      `#aperture{--fill:${chrome.bar};width:${clip.width}px;height:${clip.height}px}`,
    ].join(""),
    '<div id="mockup" data-record-mockup><div id="window">' +
      '<div id="bar"><span id="lights"><i></i><i></i><i></i></span><span id="address"></span></div>' +
      '<div id="aperture" data-record-aperture class="fills"></div>' +
      "</div></div>",
  );
}

/**
 * A lid holding the clip over a base wider than it is, tapering away from the
 * viewer. Every proportion comes off the clip, so the surround is the same
 * surround whatever it is wrapped around.
 */
function laptopDocument(clip: Dimensions): string {
  const margin = scaled(clip, 0.028, 6);
  const bezel = scaled(clip, 0.011, 2);
  const chin = scaled(clip, 0.028, 6);
  const lid = clip.width + bezel * 2;
  const base = Math.round(lid * 1.075);
  const baseHeight = scaled(clip, 0.019, 5);
  const radius = scaled(clip, 0.013, 3);
  const foot = Math.max(1, Math.round(radius / 3));
  const camera = Math.max(1, Math.round(bezel / 2));

  return template(
    [
      `#mockup{width:${base + margin * 2}px;padding:${margin}px}`,
      `#lid{position:relative;width:${lid}px;margin:0 auto;padding:${bezel}px;` +
        `padding-bottom:${chin}px;border-radius:${radius}px ${radius}px ${foot}px ${foot}px;` +
        `overflow:hidden;box-shadow:${shadow(clip)}}`,
      `#aperture{--fill:#2b2b31;width:${clip.width}px;height:${clip.height}px}`,
      // Drawn over the fill rather than under it: everything inside the lid but
      // the Aperture is the fill, so anything else the lid shows is stacked.
      `#camera{position:absolute;z-index:2;top:${Math.max(1, Math.round((bezel - camera) / 2))}px;` +
        `left:50%;transform:translateX(-50%);width:${camera}px;height:${camera}px;` +
        "border-radius:50%;background:#4a4a55}",
      // Two rings: the lid's own lit edge, and the darker one the screen sits
      // in. Both are drawn over the clip, which is what an edge is.
      `#rim{position:absolute;z-index:2;inset:0;border-radius:${radius}px ${radius}px ${foot}px ${foot}px;` +
        "box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}",
      `#edge{position:absolute;z-index:2;top:${bezel}px;left:${bezel}px;` +
        `width:${clip.width}px;height:${clip.height}px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.45)}`,
      `#base{position:relative;width:${base}px;height:${baseHeight}px;` +
        "background:linear-gradient(#d3d3d9 0 18%,#bcbcc4 55%,#9d9da8);" +
        "clip-path:polygon(0 0,100% 0,96.8% 100%,3.2% 100%);" +
        `border-radius:0 0 ${Math.round(radius / 2)}px ${Math.round(radius / 2)}px}`,
      // The lip you push the lid open by, and the deck edge it is cut into.
      `#lip{position:absolute;top:0;left:50%;transform:translateX(-50%);width:13%;` +
        `height:${Math.max(1, Math.round(baseHeight / 3))}px;background:#8f8f9b;` +
        "border-radius:0 0 999px 999px}",
    ].join(""),
    '<div id="mockup" data-record-mockup>' +
      '<div id="lid"><div id="aperture" data-record-aperture class="fills"></div>' +
      '<div id="camera"></div><div id="edge"></div><div id="rim"></div></div>' +
      '<div id="base"><div id="lip"></div></div>' +
      "</div>",
  );
}

/** How tall a handset is against its own width, which is what makes it a handset. */
const phoneAspect = 19.5 / 9;

/**
 * A handset standing in the middle of a canvas the shape of the clip, so that a
 * portrait surround does not turn a landscape Project into a portrait Artifact.
 * Its aperture is portrait whatever the clip is, and a clip wider than it is
 * cropped to the middle -- recording at a phone viewport is what fills it.
 */
function phoneDocument(clip: Dimensions): string {
  const margin = scaled(clip, 0.03, 6);
  const height = clip.height;
  const width = Math.max(24, Math.round(height / phoneAspect));
  const bezel = Math.max(2, Math.round(width * 0.028));
  const radius = Math.max(4, Math.round(width * 0.145));
  const island = Math.max(2, Math.round(width * 0.032));
  const button = Math.max(1, Math.round(width * 0.012));

  return template(
    [
      `#mockup{position:relative;display:flex;align-items:center;justify-content:center;` +
        `width:${clip.width + margin * 2}px;height:${clip.height + margin * 2}px;padding:${margin}px}`,
      `#body{position:relative;width:${width}px;height:${height}px;padding:${bezel}px;` +
        `border-radius:${radius}px;overflow:hidden;box-shadow:${shadow(clip)}}`,
      `#aperture{--fill:#26262c;width:${width - bezel * 2}px;height:${height - bezel * 2}px;` +
        `border-radius:${Math.max(2, radius - bezel)}px}`,
      // The pill cut out of the top of the screen, and the lit edge of the body.
      `#island{position:absolute;z-index:2;top:${bezel + island}px;left:50%;transform:translateX(-50%);` +
        `width:26%;height:${island}px;border-radius:999px;background:#1b1b20}`,
      `#rim{position:absolute;z-index:2;inset:0;border-radius:${radius}px;` +
        "box-shadow:inset 0 0 0 1px rgba(255,255,255,.10)}",
      // Buttons on the sides rather than the front, so they read as a handset
      // without anything being drawn over the clip.
      `.button{position:absolute;z-index:1;width:${button}px;background:#1f1f25;border-radius:999px}`,
      `#volume{left:calc(50% - ${Math.round(width / 2) + button}px);top:34%;height:9%}`,
      `#power{left:calc(50% + ${Math.round(width / 2)}px);top:38%;height:12%}`,
    ].join(""),
    '<div id="mockup" data-record-mockup>' +
      '<span id="volume" class="button"></span><span id="power" class="button"></span>' +
      '<div id="body"><div id="aperture" data-record-aperture class="fills"></div>' +
      '<div id="island"></div><div id="rim"></div></div>' +
      "</div>",
  );
}
