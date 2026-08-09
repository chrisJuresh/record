/**
 * Actions: the named pieces of on-screen motion a Project can be recorded
 * performing. An Action is a TypeScript module (ADR 0004) declaring its
 * Parameters and building a Timeline from them, loaded from the Project's
 * `actions/` directory.
 *
 * The declared defaults belong to whoever wrote the Action; Overrides belong to
 * whoever is tuning it, and live in a sidecar beside the module (ADR 0005).
 * Merging the two is a pure function, so which value won is testable without a
 * browser.
 */
import { pathToFileURL } from "node:url";

import { RecordError } from "./errors.js";
import type { EasingName, Timeline } from "./timeline.js";

/** A tunable number -- a distance, a duration, a framerate -- with a range. */
export type NumberParameter = {
  readonly kind: "number";
  readonly describes: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
};

/** A tunable easing curve. */
export type EasingParameter = {
  readonly kind: "easing";
  readonly describes: string;
  readonly default: EasingName;
};

export type ParameterDeclaration = NumberParameter | EasingParameter;

export type Parameters = Readonly<Record<string, ParameterDeclaration>>;

export type ParameterValue<D extends ParameterDeclaration> = D extends NumberParameter
  ? number
  : EasingName;

export type ParameterValues<P extends Parameters> = { readonly [K in keyof P]: ParameterValue<P[K]> };

/** Values chosen by hand, as they were read from the sidecar. */
export type Overrides = Readonly<Record<string, number | string>>;

/** What an Action will actually run with, and how it came to be that. */
export type EffectiveParameters<P extends Parameters = Parameters> = {
  readonly values: ParameterValues<P>;
  /** Names taking their value from an Override rather than from the declaration. */
  readonly overridden: readonly string[];
  /** Overrides that could not be applied, said out loud rather than dropped. */
  readonly warnings: readonly string[];
};

/**
 * What an Action module default-exports. Declaring `parameters` with `as const`
 * is what gives `timeline` a value for each of them under its own name.
 */
export type Action<P extends Parameters = Parameters> = {
  readonly parameters: P;
  timeline(values: ParameterValues<P>): Timeline;
};

const easingNames: readonly EasingName[] = [
  "linear",
  "ease-in-cubic",
  "ease-out-cubic",
  "ease-in-out-cubic",
];

/**
 * The Parameter values an Action runs with: what it declares, with Overrides
 * laid over the top.
 *
 * An Override the Action no longer declares is a warning rather than a failure.
 * Tuning outlives the code it was tuning, and a stale sidecar should cost a
 * line of output rather than the Run -- but it must never pass unmentioned,
 * because an Override that quietly does nothing is worse than one that fails.
 */
export function effectiveParameters<P extends Parameters>(
  parameters: P,
  overrides: Overrides = {},
): EffectiveParameters<P> {
  const values: Record<string, number | EasingName> = {};
  const overridden: string[] = [];
  const warnings: string[] = [];

  for (const [name, declaration] of Object.entries(parameters)) {
    if (declaration.kind === "number" && !within(declaration)) {
      throw new RecordError(
        `Parameter '${name}' defaults to ${declaration.default}, outside its own range ` +
          `${declaration.min}..${declaration.max}`,
      );
    }

    const chosen = overrides[name];
    if (chosen === undefined) {
      values[name] = declaration.default;
      continue;
    }

    const refused = refuses(declaration, chosen);
    if (refused === undefined) {
      values[name] = chosen as number | EasingName;
      overridden.push(name);
    } else {
      values[name] = declaration.default;
      warnings.push(`Override '${name}' ${refused}, so the declared default is used instead`);
    }
  }

  for (const name of Object.keys(overrides)) {
    if (parameters[name] === undefined) {
      warnings.push(`Override '${name}' names a Parameter this Action no longer declares`);
    }
  }

  return { values: values as ParameterValues<P>, overridden, warnings };
}

/**
 * One Override as it was typed, checked against what the Action declares.
 *
 * This is the gate values come in through, so it refuses rather than warns: a
 * value rejected here was never written down, and saying so is the only way the
 * person setting it finds out.
 */
export function overrideFrom(parameters: Parameters, name: string, text: string): number | EasingName {
  const declaration = parameters[name];

  if (declaration === undefined) {
    const declared = Object.keys(parameters);
    throw new RecordError(
      `'${name}' is not a Parameter this Action declares. It declares ` +
        (declared.length === 0 ? "none" : declared.join(", ")),
    );
  }

  if (declaration.kind === "easing") {
    if (!easingNames.includes(text as EasingName)) {
      throw new RecordError(`'${name}' takes one of ${easingNames.join(", ")}, not '${text}'`);
    }
    return text as EasingName;
  }

  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) {
    throw new RecordError(`'${name}' takes a number, not '${text}'`);
  }
  if (value < declaration.min || value > declaration.max) {
    throw new RecordError(
      `'${name}' takes a number between ${declaration.min} and ${declaration.max}, not ${value}`,
    );
  }
  return value;
}

/** The Action a module file declares, or a message saying how it fails to declare one. */
export async function loadAction(file: string): Promise<Action> {
  const module: unknown = await import(pathToFileURL(file).href);
  const declared = (module as { default?: unknown }).default;

  if (!isRecord(declared) || typeof declared["timeline"] !== "function") {
    throw new RecordError(`${file} must default-export an Action with a timeline() function`);
  }

  const parameters = declared["parameters"];
  if (!isRecord(parameters)) {
    throw new RecordError(`${file} must default-export an Action declaring its parameters`);
  }

  for (const [name, declaration] of Object.entries(parameters)) {
    assertDeclares(file, name, declaration);
  }

  return declared as unknown as Action;
}

/** Why a declaration will not take a value, or undefined if it will. */
function refuses(declaration: ParameterDeclaration, value: number | string): string | undefined {
  if (declaration.kind === "easing") {
    return easingNames.includes(value as EasingName)
      ? undefined
      : `is '${String(value)}', which is not one of ${easingNames.join(", ")}`;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `is '${String(value)}', which is not a number`;
  }
  return value >= declaration.min && value <= declaration.max
    ? undefined
    : `is ${value}, outside the declared range ${declaration.min}..${declaration.max}`;
}

function assertDeclares(file: string, name: string, declaration: unknown): void {
  const wrong = (why: string): never => {
    throw new RecordError(`${file}: Parameter '${name}' ${why}`);
  };

  if (!isRecord(declaration)) {
    return wrong("is not a Parameter declaration");
  }

  switch (declaration["kind"]) {
    case "number":
      return ["default", "min", "max"].every((key) => typeof declaration[key] === "number")
        ? undefined
        : wrong("must declare a numeric default, min and max");
    case "easing":
      return easingNames.includes(declaration["default"] as EasingName)
        ? undefined
        : wrong(`must default to one of ${easingNames.join(", ")}`);
    default:
      return wrong(`declares an unknown kind '${String(declaration["kind"])}'`);
  }
}

function within(declaration: NumberParameter): boolean {
  return declaration.default >= declaration.min && declaration.default <= declaration.max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
