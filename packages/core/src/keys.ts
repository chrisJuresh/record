/**
 * The keys an Action can press. A key is named rather than free text so that a
 * misspelt one fails while the Timeline is being evaluated -- before a browser
 * is launched -- rather than pressing nothing halfway through a Run.
 */
import { RecordError } from "./errors.js";

/** Keys with a name of their own rather than the character they type. */
export type KeyName =
  | "Enter"
  | "Tab"
  | "Space"
  | "Escape"
  | "Backspace"
  | "Delete"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

type Lowercase_ =
  // prettier-ignore
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";

/**
 * What `press` will take. Spelt out rather than left as a string because ADR
 * 0004 chose TypeScript for Actions precisely so that a wrong name is caught
 * by `pnpm build` rather than ten seconds into a render.
 */
export type Key = KeyName | Lowercase_ | Uppercase<Lowercase_> | `${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

/** One keystroke, in the terms the browser wants it dispatched in. */
export type KeyStroke = {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  /** The character the key inserts, for the keys that insert one. */
  readonly text?: string;
};

/** Keys with a name of their own rather than the character they type. */
const named: Readonly<Record<string, KeyStroke>> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/**
 * The keystroke a name asks for, or a failure listing what there is. A single
 * letter or digit is a key too, which is what a one-key shortcut needs; longer
 * text belongs to `type` rather than to `press`.
 *
 * Typed rather than checked wherever an Action is concerned -- this is the
 * backstop for a name that reached here from somewhere untyped.
 */
export function keyStroke(key: string): KeyStroke {
  const byName = named[key];
  if (byName !== undefined) {
    return byName;
  }

  if (/^[a-zA-Z0-9]$/.test(key)) {
    const upper = key.toUpperCase();
    return {
      key,
      code: /[0-9]/.test(key) ? `Digit${key}` : `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: key,
    };
  }

  throw new RecordError(
    `'${key}' is not a key that can be pressed. Press a single letter or digit, ` +
      `or one of ${Object.keys(named).join(", ")}`,
  );
}

/**
 * What one keystroke reads as when it is captioned on screen: the key's own
 * name where it has one, and otherwise the character it types.
 *
 * Read back off the stroke rather than carried alongside it, because a stroke
 * is what the browser is sent and a caption is what a viewer is shown -- the
 * two travel together only as far as the Frame they belong to.
 */
export function strokeLabel(stroke: KeyStroke): string {
  return labels[stroke.code] ?? stroke.text ?? stroke.key;
}

/** The name each named key is known by, found by the code it is dispatched as. */
const labels: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(named).map(([name, stroke]) => [stroke.code, name]),
);

/**
 * The keystroke that types one character, whatever it is.
 *
 * Typing has to arrive as keystrokes rather than as inserted text: a page that
 * filters as you type, or answers a shortcut, listens for the key and would
 * record as though nothing had been typed at all. The virtual key code is the
 * character's own, which is what a page reading `event.key` and the text it
 * inserts both depend on.
 */
export function characterStroke(character: string): KeyStroke {
  const named = /^[a-zA-Z0-9]$/.test(character) ? keyStroke(character) : undefined;

  return (
    named ?? {
      key: character,
      code: "",
      keyCode: character.toUpperCase().charCodeAt(0),
      text: character,
    }
  );
}
