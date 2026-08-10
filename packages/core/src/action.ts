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

import { artifactParameters } from "./artifacts.js";
import { cursorParameters } from "./cursor.js";
import { RecordError } from "./errors.js";
import { automaticMockup, mockupParameters } from "./mockup.js";
import type { ParameterSetting } from "./settings.js";
import { assertTextOverrides, type TextOverrides } from "./text.js";
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

/** One of a named set, so that tuning it is a choice rather than a spelling. */
export type ChoiceParameter = {
  readonly kind: "choice";
  readonly describes: string;
  readonly default: string;
  readonly choices: readonly string[];
};

/** On or off, and off unless something is deliberately turned on. */
export type FlagParameter = {
  readonly kind: "flag";
  readonly describes: string;
  readonly default: boolean;
};

export type ParameterDeclaration =
  | NumberParameter
  | EasingParameter
  | ChoiceParameter
  | FlagParameter;

export type Parameters = Readonly<Record<string, ParameterDeclaration>>;

export type ParameterValue<D extends ParameterDeclaration> = D extends NumberParameter
  ? number
  : D extends EasingParameter
    ? EasingName
    : D extends FlagParameter
      ? boolean
      : D extends ChoiceParameter
        ? D["choices"][number]
        : never;

export type ParameterValues<P extends Parameters> = { readonly [K in keyof P]: ParameterValue<P[K]> };

/** Values chosen by hand, as they were read from the sidecar. */
export type Overrides = Readonly<Record<string, ParameterSetting>>;

/**
 * As much of a Project as its Actions' Parameters depend on: the Mockup it
 * chose, which every one of them carries as a default it may override.
 */
export type MockupChoice = { readonly mockup: string };

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
  /**
   * Replacement copy substituted into the page before the first Frame, by the
   * selector of the elements it replaces. Copy rather than motion, so it is
   * declared beside the Timeline rather than inside it.
   */
  readonly text?: TextOverrides;
  timeline(values: ParameterValues<P>): Timeline;
};

const easingNames: readonly EasingName[] = [
  "linear",
  "ease-in-cubic",
  "ease-out-cubic",
  "ease-in-out-cubic",
];

/**
 * Every Parameter an Action runs with: the ones it declares, and the ones every
 * Action carries whether it names them or not -- the cursor drawn over the
 * page, the Mockup composited around it, and the Artifacts encoded from it
 * (ADR 0006). The carried ones come last, so that a listing reads as the Action
 * first, then what is drawn around it, then what is done with its Frames.
 *
 * The Mockup is carried like the rest but defaults to the Project's own choice
 * rather than to a constant, because a Mockup is chosen for a Project and
 * overridden for the one Action that wants a different one.
 *
 * An Action naming one of the carried Parameters is refused rather than allowed
 * to shadow it, because two declarations of one name leave no way to say which
 * an Override meant.
 */
export function allParameters(action: Action, project?: MockupChoice): Parameters {
  const carried: Parameters = {
    ...cursorParameters,
    ...mockupParameters(project?.mockup ?? automaticMockup),
    ...artifactParameters,
  };

  for (const name of Object.keys(carried)) {
    if (action.parameters[name] !== undefined) {
      throw new RecordError(
        `Parameter '${name}' is carried by every Action already, so declaring it would shadow it`,
      );
    }
  }

  return { ...action.parameters, ...carried };
}

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
  const values: Record<string, ParameterSetting> = {};
  const overridden: string[] = [];
  const warnings: string[] = [];

  for (const [name, declaration] of Object.entries(parameters)) {
    assertDefaults(name, declaration);

    const chosen = overrides[name];
    if (chosen === undefined) {
      values[name] = declaration.default;
      continue;
    }

    const refused = refuses(declaration, chosen);
    if (refused === undefined) {
      values[name] = chosen;
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
export function overrideFrom(parameters: Parameters, name: string, text: string): ParameterSetting {
  const declaration = parameters[name];

  if (declaration === undefined) {
    const declared = Object.keys(parameters);
    throw new RecordError(
      `'${name}' is not a Parameter this Action declares. It declares ` +
        (declared.length === 0 ? "none" : declared.join(", ")),
    );
  }

  if (declaration.kind === "easing" || declaration.kind === "choice") {
    const choices = choicesOf(declaration);
    if (!choices.includes(text)) {
      throw new RecordError(`'${name}' takes one of ${choices.join(", ")}, not '${text}'`);
    }
    return text;
  }

  if (declaration.kind === "flag") {
    if (text !== "true" && text !== "false") {
      throw new RecordError(`'${name}' takes true or false, not '${text}'`);
    }
    return text === "true";
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

  const text = declared["text"];
  if (text !== undefined) {
    assertTextOverrides(file, text);
  }

  return declared as unknown as Action;
}

/** Why a declaration will not take a value, or undefined if it will. */
function refuses(declaration: ParameterDeclaration, value: ParameterSetting): string | undefined {
  if (declaration.kind === "easing" || declaration.kind === "choice") {
    const choices = choicesOf(declaration);

    return typeof value === "string" && choices.includes(value)
      ? undefined
      : `is '${String(value)}', which is not one of ${choices.join(", ")}`;
  }

  if (declaration.kind === "flag") {
    return typeof value === "boolean" ? undefined : `is '${String(value)}', which is not true or false`;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `is '${String(value)}', which is not a number`;
  }
  return value >= declaration.min && value <= declaration.max
    ? undefined
    : `is ${value}, outside the declared range ${declaration.min}..${declaration.max}`;
}

/** The values a declaration of a named set will take, whichever set it is. */
function choicesOf(declaration: EasingParameter | ChoiceParameter): readonly string[] {
  return declaration.kind === "easing" ? easingNames : declaration.choices;
}

/**
 * A declaration whose own default it would refuse is a declaration nobody can
 * run, so it fails while the Parameters are being resolved rather than leaving
 * an Action that always warns about itself.
 */
function assertDefaults(name: string, declaration: ParameterDeclaration): void {
  if (declaration.kind === "number" && !within(declaration)) {
    throw new RecordError(
      `Parameter '${name}' defaults to ${declaration.default}, outside its own range ` +
        `${declaration.min}..${declaration.max}`,
    );
  }

  if (declaration.kind === "choice" && !declaration.choices.includes(declaration.default)) {
    throw new RecordError(
      `Parameter '${name}' defaults to '${declaration.default}', which is not one of ` +
        `${declaration.choices.join(", ")}`,
    );
  }
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
    case "choice": {
      const choices: unknown[] = Array.isArray(declaration["choices"]) ? declaration["choices"] : [];
      const chosen: unknown = declaration["default"];

      return choices.length > 0 &&
        choices.every((choice) => typeof choice === "string") &&
        typeof chosen === "string" &&
        choices.includes(chosen)
        ? undefined
        : wrong("must declare the choices it takes, and default to one of them");
    }
    case "flag":
      return typeof declaration["default"] === "boolean"
        ? undefined
        : wrong("must default to true or false");
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
