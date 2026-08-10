/**
 * Putting a page into a colour scheme, so that one Action can be recorded in
 * light and in dark without a second Action being written for the second theme.
 *
 * There are two ways, and the Project decides which. By default the browser is
 * told what the reader prefers, which is the whole of what a site built on
 * `prefers-color-scheme` needs and costs the Project no configuration at all. A
 * Project whose theme is a class, an attribute or a stored preference declares a
 * hook instead: one expression per scheme, evaluated in the page.
 *
 * A declared hook is used **in preference** to emulating the media query rather
 * than as well as it. A site that decides its own theme is a site that ignores
 * the query, so emulating it alongside would leave the hook doing all the work
 * and the emulation reading as though it had done some.
 *
 * Whether the page then actually changes is the page's own business, and is
 * reported rather than enforced: a site with only one theme is legitimately
 * recorded in that theme, and a Run says what the page it photographed reads as.
 */
import type { ColourScheme } from "./capture.js";

/**
 * How a Project switches its own theme: one expression per scheme, evaluated in
 * the page after it has loaded and before the first Frame is captured.
 */
export type ThemeHooks = {
  readonly light: string;
  readonly dark: string;
};

/** How one Run puts the page into the scheme its Condition asked for. */
export type ThemeSwitch =
  | { readonly kind: "emulated"; readonly scheme: ColourScheme }
  | { readonly kind: "hook"; readonly scheme: ColourScheme; readonly expression: string };

/**
 * How this Run switches the theme, or nothing at all for a Run whose Condition
 * asked for no scheme -- which records the page exactly as it paints itself,
 * rather than telling it that light is preferred.
 */
export function themeSwitch(
  scheme: ColourScheme | undefined,
  hooks: ThemeHooks | undefined,
): ThemeSwitch | undefined {
  if (scheme === undefined) {
    return undefined;
  }

  return hooks === undefined
    ? { kind: "emulated", scheme }
    : { kind: "hook", scheme, expression: hooks[scheme] };
}
