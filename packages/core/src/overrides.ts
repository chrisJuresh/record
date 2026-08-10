/**
 * Overrides: the Parameter values chosen by hand, kept in a sidecar beside the
 * Action they tune (ADR 0005).
 *
 * The Action module and its sidecar have one owner each -- whoever writes the
 * Action owns the declarations, whoever tunes it owns the sidecar -- so neither
 * can destroy the other's work, and resetting a Parameter is deleting a line
 * rather than editing code.
 */
import { readFile, unlink, writeFile } from "node:fs/promises";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import {
  allParameters,
  effectiveParameters,
  loadAction,
  overrideFrom,
  type Overrides,
  type ParameterDeclaration,
  type Parameters,
} from "./action.js";
import { actionModule, overridesFile, readProject } from "./config.js";
import { RecordError } from "./errors.js";
import type { ParameterSetting } from "./settings.js";

/** One declared Parameter, with what it is currently worth and why. */
export type ReportedParameter = {
  readonly name: string;
  readonly kind: ParameterDeclaration["kind"];
  readonly describes: string;
  readonly default: ParameterSetting;
  /** The range a number is tuned within, and nothing for the other kinds. */
  readonly min?: number;
  readonly max?: number;
  /** The values a choice takes, so that tuning it is picking one of them. */
  readonly choices?: readonly string[];
  readonly value: ParameterSetting;
  readonly overridden: boolean;
};

/** Everything tunable about one Action, and anything wrong with its sidecar. */
export type ParameterReport = {
  readonly project: string;
  readonly action: string;
  /** Where the Overrides are kept, whether or not there are any yet. */
  readonly sidecar: string;
  readonly parameters: readonly ReportedParameter[];
  readonly warnings: readonly string[];
};

/**
 * The Overrides recorded for one Action. A sidecar that is not there is an
 * Action nobody has tuned, which is the ordinary case rather than a failure.
 */
export async function readOverrides(
  workspace: string,
  project: string,
  action: string,
): Promise<Overrides> {
  const file = overridesFile(workspace, project, action);

  const text = await readFile(file, "utf8").catch((failure: NodeJS.ErrnoException) => {
    if (failure.code === "ENOENT") {
      return undefined;
    }
    throw failure;
  });

  if (text === undefined) {
    return {};
  }

  let table: unknown;
  try {
    table = parseToml(text);
  } catch (failure) {
    throw new RecordError(`${file} is not valid TOML: ${(failure as Error).message}`);
  }

  // Anything that is neither a number nor a flag is carried across as the text
  // it was written as, so that a value of the wrong shape is reported against
  // the Parameter it was meant for rather than silently disappearing on the way
  // in.
  return Object.fromEntries(
    Object.entries(table as Record<string, unknown>).map(([name, value]) => [
      name,
      typeof value === "number" || typeof value === "boolean" ? value : String(value),
    ]),
  );
}

/** What an Action declares, what it is tuned to, and what it will run with. */
export async function readParameters(
  workspace: string,
  project: string,
  action: string,
): Promise<ParameterReport> {
  const { declared, overrides } = await tuning(workspace, project, action);

  return report(workspace, project, action, declared, overrides);
}

/** Records Overrides written as `name=value`, refusing any the Action will not take. */
export async function setOverrides(
  workspace: string,
  project: string,
  action: string,
  assignments: readonly string[],
): Promise<ParameterReport> {
  const { declared, overrides } = await tuning(workspace, project, action);

  for (const assignment of assignments) {
    const at = assignment.indexOf("=");
    if (at <= 0) {
      throw new RecordError(`an Override is written name=value, not '${assignment}'`);
    }
    const name = assignment.slice(0, at);
    overrides[name] = overrideFrom(declared, name, assignment.slice(at + 1));
  }

  await writeOverrides(workspace, project, action, overrides);

  return report(workspace, project, action, declared, overrides);
}

/**
 * Removes Overrides by name, restoring what the Action declares.
 *
 * A name the Action no longer declares can be reset like any other, because
 * that is how a sidecar left behind by a rewritten Action is cleared.
 */
export async function resetOverrides(
  workspace: string,
  project: string,
  action: string,
  names: readonly string[],
): Promise<ParameterReport> {
  const { declared, overrides } = await tuning(workspace, project, action);

  for (const name of names) {
    if (overrides[name] === undefined) {
      throw new RecordError(`'${name}' is not overridden, so there is nothing to reset`);
    }
    delete overrides[name];
  }

  await writeOverrides(workspace, project, action, overrides);

  return report(workspace, project, action, declared, overrides);
}

/**
 * Everything tunable about one Action -- what it declares, what every Action
 * carries, and what its Project chose for the ones it chooses -- and what has
 * been tuned on top of it. The Overrides come back as a copy, because every
 * caller but one is about to change them.
 */
async function tuning(
  workspace: string,
  project: string,
  action: string,
): Promise<{ declared: Parameters; overrides: Record<string, ParameterSetting> }> {
  // The Action first, so that a name nobody declared is answered by the Action
  // that does not exist rather than by the Project that does.
  const module = await loadAction(await actionModule(workspace, project, action));
  const declared = allParameters(module, await readProject(workspace, project));

  return { declared, overrides: { ...(await readOverrides(workspace, project, action)) } };
}

/** An Action with no Overrides left has no sidecar, so resetting the last one removes the file. */
async function writeOverrides(
  workspace: string,
  project: string,
  action: string,
  overrides: Overrides,
): Promise<void> {
  const file = overridesFile(workspace, project, action);

  if (Object.keys(overrides).length === 0) {
    await unlink(file).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });
    return;
  }

  await writeFile(file, `${stringifyToml(overrides)}\n`, "utf8");
}

function report(
  workspace: string,
  project: string,
  action: string,
  declared: Parameters,
  overrides: Overrides,
): ParameterReport {
  const effective = effectiveParameters(declared, overrides);

  return {
    project,
    action,
    sidecar: overridesFile(workspace, project, action),
    parameters: Object.entries(declared).map(([name, declaration]) => ({
      name,
      kind: declaration.kind,
      describes: declaration.describes,
      default: declaration.default,
      ...(declaration.kind === "number" ? { min: declaration.min, max: declaration.max } : {}),
      ...(declaration.kind === "choice" ? { choices: declaration.choices } : {}),
      value: effective.values[name] as ParameterSetting,
      overridden: effective.overridden.includes(name),
    })),
    warnings: effective.warnings,
  };
}
