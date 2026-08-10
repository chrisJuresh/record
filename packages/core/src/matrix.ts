/**
 * A Matrix: the Runs of one Action across varied conditions, produced by one
 * request -- light and dark, or several viewport widths.
 *
 * The alternative is a second Action that differs from the first in one line,
 * and then a third, each of them tuned separately and each of them going Stale
 * on its own. A Condition varies the circumstances a Run records under and
 * nothing about what the Action does, which is why it is asked for at the
 * command rather than declared in the module: how a clip is lit is not motion.
 *
 * Every Condition is one ordinary Run. It keeps a directory of its own, prunes
 * its own ten, and queues for the machine beside every other Run -- a Matrix is
 * a way of asking for Runs, not a second kind of Run.
 */
import type { ColourScheme } from "./capture.js";
import { RecordError } from "./errors.js";

/** The colour schemes a Matrix can put a page into. */
export const colourSchemes: readonly ColourScheme[] = ["light", "dark"];

/**
 * The narrowest and widest viewport a Matrix will record at. Wide enough for a
 * desktop breakpoint at the top, and narrow enough at the bottom that the page
 * still has somewhere to lay out.
 */
export const widthRange = { min: 120, max: 7680 } as const;

/** One set of circumstances an Action is recorded under, within a Matrix. */
export type Condition = {
  /** What the Run is kept under, and what its Artifacts are named after. */
  readonly name: string;
  /** The colour scheme the page is put into, or nothing to record it as it paints. */
  readonly scheme?: ColourScheme;
  /** The viewport width it is recorded at, or nothing for the Project's own. */
  readonly width?: number;
};

/** What one request asked a Matrix to vary, as it was typed. */
export type MatrixRequest = {
  /** Colour schemes, each `light` or `dark`. */
  readonly schemes?: readonly string[];
  /** Viewport widths, in CSS pixels. */
  readonly widths?: readonly string[];
};

/**
 * The Conditions a request comes to: every colour scheme asked for against
 * every viewport width asked for.
 *
 * A request that varies nothing produces no Conditions at all rather than one
 * that varies nothing, so a plain `record run` records exactly what it recorded
 * before this feature existed -- in the Action's own directory, under the
 * Action's own name.
 */
export function conditionsFor(request: MatrixRequest): readonly Condition[] {
  const schemes = (request.schemes ?? []).map(asScheme);
  const widths = (request.widths ?? []).map(asWidth);

  if (schemes.length === 0 && widths.length === 0) {
    return [];
  }

  assertAskedOnce("colour scheme", schemes);
  assertAskedOnce("viewport width", widths.map(String));

  const conditions: Condition[] = [];

  for (const scheme of schemes.length === 0 ? [undefined] : schemes) {
    for (const width of widths.length === 0 ? [undefined] : widths) {
      conditions.push({
        name: nameOf(scheme, width),
        ...(scheme === undefined ? {} : { scheme }),
        ...(width === undefined ? {} : { width }),
      });
    }
  }

  return conditions;
}

/**
 * What one Condition is called. It is a directory name and half of an Artifact's
 * filename, so it is written the way the Artifacts read: `dark`, `900w`, and
 * `dark-900w` where both were varied.
 */
function nameOf(scheme: ColourScheme | undefined, width: number | undefined): string {
  return [
    ...(scheme === undefined ? [] : [scheme]),
    ...(width === undefined ? [] : [`${width}w`]),
  ].join("-");
}

function asScheme(given: string): ColourScheme {
  if (!colourSchemes.includes(given as ColourScheme)) {
    throw new RecordError(
      `'${given}' is not a colour scheme to record in. There is ${colourSchemes.join(" and ")}`,
    );
  }
  return given as ColourScheme;
}

function asWidth(given: string): number {
  const width = Number(given);

  if (given.trim() === "" || !Number.isInteger(width)) {
    throw new RecordError(`'${given}' is not a viewport width to record at, in whole CSS pixels`);
  }
  if (width < widthRange.min || width > widthRange.max) {
    throw new RecordError(
      `${width} is not a viewport width to record at: they run ` +
        `${widthRange.min} to ${widthRange.max}`,
    );
  }

  return width;
}

/**
 * The same condition asked for twice is refused rather than deduplicated. Two
 * Runs would be kept under one name, each writing over what the other reported,
 * and quietly recording one of them is not what was asked for either.
 */
function assertAskedOnce(varying: string, asked: readonly string[]): void {
  const seen = new Set<string>();

  for (const one of asked) {
    if (seen.has(one)) {
      throw new RecordError(`the ${varying} '${one}' is asked for twice, and a Matrix records each once`);
    }
    seen.add(one);
  }
}
