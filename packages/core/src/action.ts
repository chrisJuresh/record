/**
 * Actions: the named pieces of on-screen motion a Project can be recorded
 * performing. An Action is a TypeScript module (ADR 0004) declaring its
 * Parameters and building a Timeline from them, loaded from the Project's
 * `actions/` directory.
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
 * The Parameter values an Action runs with. Today that is what the Action
 * declares; Overrides join them here once they exist, which is why the Timeline
 * is built from this rather than from the declarations directly.
 */
export function effectiveParameters<P extends Parameters>(parameters: P): ParameterValues<P> {
  const values: Record<string, number | EasingName> = {};

  for (const [name, declaration] of Object.entries(parameters)) {
    if (declaration.kind === "number" && !within(declaration)) {
      throw new RecordError(
        `Parameter '${name}' defaults to ${declaration.default}, outside its own range ` +
          `${declaration.min}..${declaration.max}`,
      );
    }
    values[name] = declaration.default;
  }

  return values as ParameterValues<P>;
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
