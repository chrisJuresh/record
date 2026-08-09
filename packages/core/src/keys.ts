/**
 * The keys an Action can press. A key is named rather than free text so that a
 * misspelt one fails while the Timeline is being evaluated -- before a browser
 * is launched -- rather than pressing nothing halfway through a Run.
 */
import { RecordError } from "./errors.js";

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
