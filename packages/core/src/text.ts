/**
 * Text overrides: replacement copy substituted into the page after it has
 * loaded and before the first Frame is captured, so that a clip can show the
 * wording it was meant to show rather than whatever the running site happens to
 * contain that day.
 *
 * This is a presentation feature and not a privacy one. A Project whose content
 * must not be exposed stays unpublished (ADR 0007); nothing here is a redaction.
 *
 * Substitution is one pass over the page, decided entirely by what the Action
 * declared, so it cannot make two Runs of one Action differ. A selector that
 * matched nothing is the one thing it will not pass over: copy that quietly
 * failed to land is a clip of the wrong words, which is exactly what the
 * feature exists to prevent.
 */
import { RecordError } from "./errors.js";

/** Replacement copy by the selector of the elements it is substituted into. */
export type TextOverrides = Readonly<Record<string, string>>;

/** One selector's substitution as it happened, kept by the Run that made it. */
export type Substitution = {
  readonly selector: string;
  /** The copy that was substituted in. */
  readonly copy: string;
  /** How many elements the selector matched, which is never none. */
  readonly matched: number;
};

/** The substitution a Run carries out: asked of the page once, then read. */
export type TextSubstitution = {
  /** What the page is asked to do, as an expression answering with what it matched. */
  readonly script: string;
  /** What the page answered, or a failure naming the copy that never landed. */
  substituted(answer: unknown): readonly Substitution[];
};

/**
 * The substitution an Action's declared copy amounts to, or nothing at all for
 * an Action that declares none -- which leaves the page exactly as it would
 * have been recorded without the feature, rather than asking it to substitute
 * an empty list.
 */
export function textSubstitution(overrides: TextOverrides): TextSubstitution | undefined {
  const declared = Object.entries(overrides).map(([selector, copy]) => ({ selector, copy }));

  if (declared.length === 0) {
    return undefined;
  }

  return {
    script: ["(() => {", `const overrides = ${JSON.stringify(declared)};`, substitute, "})()"].join(
      "\n",
    ),
    substituted: (answer) => read(declared, answer),
  };
}

/**
 * How an Action's declaration of its copy fails to be one. Read while the
 * module is loaded, so a mistyped override costs nothing and is found before a
 * browser is ever launched.
 */
export function assertTextOverrides(file: string, declared: unknown): void {
  const wrong = (why: string): never => {
    throw new RecordError(`${file}: text overrides ${why}`);
  };

  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    return wrong("must be a mapping from element selector to replacement copy");
  }

  for (const [selector, copy] of Object.entries(declared)) {
    if (selector.trim() === "") {
      wrong("must be named by a selector, and one of them is blank");
    }
    if (typeof copy !== "string") {
      wrong(`for '${selector}' must be the copy to substitute in, not ${typeof copy}`);
    }
  }
}

/** What the page answered, checked against what it was asked to substitute. */
function read(
  declared: readonly { selector: string; copy: string }[],
  answer: unknown,
): readonly Substitution[] {
  if (!Array.isArray(answer) || answer.length !== declared.length) {
    throw new RecordError("the page did not say what the text overrides matched");
  }

  const substitutions: Substitution[] = [];
  const missed: string[] = [];

  for (const [at, override] of declared.entries()) {
    const matched = (answer[at] as { matched?: unknown } | undefined)?.matched;

    if (matched === null) {
      missed.push(`'${override.selector}' is not a selector the page understands`);
    } else if (typeof matched !== "number") {
      throw new RecordError("the page did not say what the text overrides matched");
    } else if (matched === 0) {
      missed.push(`'${override.selector}' matched nothing in the page`);
    } else {
      substitutions.push({ selector: override.selector, copy: override.copy, matched });
    }
  }

  if (missed.length > 0) {
    throw new RecordError(`the text override ${missed.join(", and the text override ")}`);
  }

  return substitutions;
}

/**
 * The substitution itself, as the page carries it out. It answers with what
 * each selector matched rather than deciding anything: whether copy that landed
 * nowhere is worth a Run is settled here, in Node, where the message can name
 * the Action.
 *
 * A field's copy is its value rather than its text, because writing text into
 * an input changes nothing anybody can see -- and copy that lands invisibly is
 * the silent skipping this whole module refuses.
 */
const substitute = `
  return overrides.map((override) => {
    let elements;

    try {
      elements = document.querySelectorAll(override.selector);
    } catch {
      return { selector: override.selector, matched: null };
    }

    for (const element of elements) {
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        element.value = override.copy;
      } else {
        element.textContent = override.copy;
      }
    }

    return { selector: override.selector, matched: elements.length };
  });
`;
