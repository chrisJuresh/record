/**
 * Reading a resolved Parameter back out.
 *
 * Whatever a Parameter is for -- what is drawn over the Frames, how they are
 * encoded -- it arrives as one of three shapes, and the code that acts on it
 * has to ask for the shape it expects. Asking lives here rather than beside
 * either use, so that both ask the same question and fail the same way.
 */
import { RecordError } from "./errors.js";

/** What a Parameter is worth once it has been resolved. */
export type ParameterSetting = number | string | boolean;

/** The Parameter values a Run resolved, as whatever reads one back sees them. */
export type Settled = Readonly<Record<string, ParameterSetting>>;

export function numberSetting(values: Settled, name: string): number {
  return settingOf(values, name, "a number", (value) => typeof value === "number");
}

export function nameSetting(values: Settled, name: string): string {
  return settingOf(values, name, "a name", (value) => typeof value === "string");
}

export function flagSetting(values: Settled, name: string): boolean {
  return settingOf(values, name, "true or false", (value) => typeof value === "boolean");
}

/**
 * One value, of the shape its declaration promised.
 *
 * A value of any other shape means the declarations and whoever is reading them
 * have drifted apart, rather than that somebody typed something wrong: a value
 * typed wrong was refused as it was set, or fell back to the default saying so.
 */
function settingOf<T extends ParameterSetting>(
  values: Settled,
  name: string,
  expected: string,
  isExpected: (value: ParameterSetting | undefined) => boolean,
): T {
  const value = values[name];

  if (!isExpected(value)) {
    throw new RecordError(
      `Parameter '${name}' resolved to '${String(value)}' rather than to ${expected}`,
    );
  }
  return value as T;
}
