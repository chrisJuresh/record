/**
 * The app's icons: a few glyphs drawn on one 16-unit grid in one stroke, so
 * every control that does something says what it does before it is read.
 *
 * Drawn here rather than fetched from a set, because the app has no bundler and
 * reaches nothing off this machine (ADR 0002) -- and a dozen paths is less than
 * a dependency. They take the colour of the text they sit in; the one exception
 * is the recording dot, which is the wordmark's red wherever it appears.
 */

/** A glyph: its strokes, and which of them are filled rather than drawn. */
type Glyph = readonly { readonly d: string; readonly filled?: true }[];

const glyphs = {
  // A camera's recording light, which is what every record button is for.
  record: [{ d: "M8 3.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9z", filled: true }],
  play: [{ d: "M5.5 3.5v9l7-4.5z", filled: true }],
  pause: [{ d: "M5 3.5v9M11 3.5v9" }],
  expand: [{ d: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" }],
  eye: [
    { d: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" },
    { d: "M8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4z" },
  ],
  back: [{ d: "M9.5 3.5 5 8l4.5 4.5" }],
  tune: [
    { d: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11" },
    { d: "M6 3a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z", filled: true },
    { d: "M10.5 6.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z", filled: true },
    { d: "M5 10a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z", filled: true },
  ],
  upload: [{ d: "M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v3h11v-3" }],
  plus: [{ d: "M8 3v10M3 8h10" }],
  images: [
    { d: "M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" },
    { d: "M2.5 11 6 7.5l3 3 1.5-1.5 3 3" },
  ],
  layers: [{ d: "M8 2 14 5 8 8 2 5z" }, { d: "M2 8l6 3 6-3M2 11l6 3 6-3" }],
  folder: [{ d: "M2 4a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" }],
  film: [
    { d: "M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" },
    { d: "M5 2.5v11M11 2.5v11M2 8h3M11 8h3" },
  ],
  light: [
    { d: "M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z" },
    { d: "M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" },
  ],
  dark: [{ d: "M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" }],
} as const satisfies Record<string, Glyph>;

export type IconName = keyof typeof glyphs;

const svg = "http://www.w3.org/2000/svg";

/** One icon, hidden from assistive technology: the label beside it says it. */
export function icon(name: IconName): SVGSVGElement {
  const drawn = document.createElementNS(svg, "svg");

  drawn.setAttribute("class", `icon icon-${name}`);
  drawn.setAttribute("viewBox", "0 0 16 16");
  drawn.setAttribute("aria-hidden", "true");

  for (const stroke of glyphs[name] as Glyph) {
    const path = document.createElementNS(svg, "path");

    path.setAttribute("d", stroke.d);
    if (stroke.filled === true) {
      path.setAttribute("class", "filled");
    }
    drawn.append(path);
  }

  return drawn;
}

/** Whether a name is one there is an icon for -- a colour scheme, say. */
export function isIcon(name: string): name is IconName {
  return Object.hasOwn(glyphs, name);
}
