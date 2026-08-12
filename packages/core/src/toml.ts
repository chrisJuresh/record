/**
 * Changing what a TOML document says without disturbing what a person wrote
 * around it.
 *
 * A Project's configuration is hand-written and commented -- why a Project is
 * not Published, which port it happens to serve on -- and the app edits the
 * same file. Parsing it and writing the parse back out would leave a valid
 * document with every note in it gone, so an edit is one line rewritten in
 * place: the key keeps its spelling, its indentation and whatever was said
 * after it, and every other line of the file is untouched.
 *
 * Only what a setting is worth is ever written here. Nothing in this file knows
 * what a Project is -- which settings there are and what they mean is
 * configuration's business, and what comes back out of here is held against the
 * reader before it is ever written to disk.
 */
import { RecordError } from "./errors.js";

/** What a setting can be worth, which is what TOML calls a scalar. */
export type TomlValue = string | number | boolean;

/** One change: the key, table by table, and what it is to say. */
export type TomlEdit = {
  /** `["viewport", "width"]` is `width` under `[viewport]`. */
  readonly path: readonly string[];
  /** What it is to say, or nothing at all to take the line away. */
  readonly value: TomlValue | undefined;
};

/** Where one assignment is in the document, and how it was written. */
type Assignment = {
  readonly at: number;
  /** Everything up to and including the `=`, exactly as it was typed. */
  readonly before: string;
  /** Whatever was written after the value, which is a person's own note. */
  readonly after: string;
};

/** What the document already says, and where anything new would go. */
type Document = {
  /** Every assignment, by the whole path of the key it makes. */
  readonly assignments: Map<string, Assignment>;
  /** The line each table's last assignment is on, by the table's path. */
  readonly ends: Map<string, number>;
  /** The line each table is declared on, so an empty one can be written into. */
  readonly headers: Map<string, number>;
  /**
   * The line a new root key goes after: the last one the root already has, or
   * the last line before the first table. `-1` is a document to write above.
   */
  readonly rootEnds: number;
};

/** A table nothing may be written into, named so that no real key collides with it. */
const unwritable = "\u0000";

/**
 * The document with those changes made to it, and everything else exactly as it
 * was. A key the document does not have is written into the table it belongs
 * to, and one asked for nothing at all is taken out.
 */
export function editToml(text: string, edits: readonly TomlEdit[]): string {
  // The newline a file ends with is the file's, not a line of its own, so it is
  // put back rather than written into.
  const ending = text.endsWith("\n") ? "\n" : "";
  const lines = (ending === "" ? text : text.slice(0, -1)).split("\n");
  const document = read(lines);

  // A line this writes ends the way the document's own lines do, so editing a
  // file written on this machine does not leave it in two minds about it.
  const carriage = text.includes("\r\n") ? "\r" : "";

  /** Lines dropped, and lines to follow a line -- both held until the numbering is done with. */
  const removed = new Set<number>();
  const inserted = new Map<number, string[]>();

  const insert = (at: number, ...written: string[]): void => {
    inserted.set(at, [
      ...(inserted.get(at) ?? []),
      ...written.map((line) => `${line}${carriage}`),
    ]);
  };

  for (const edit of edits) {
    const key = keyOf(edit.path);
    const existing = document.assignments.get(key);

    if (existing !== undefined) {
      if (edit.value === undefined) {
        removed.add(existing.at);
      } else {
        lines[existing.at] = `${existing.before}${asToml(edit.value)}${existing.after}`;
      }
      continue;
    }

    // A key nobody has written down is a key already saying nothing.
    if (edit.value === undefined) {
      continue;
    }

    const table = edit.path.slice(0, -1);
    const written = `${edit.path.at(-1) ?? ""} = ${asToml(edit.value)}`;

    if (table.length === 0) {
      insert(document.rootEnds, written);
      continue;
    }

    const name = keyOf(table);
    const under = document.ends.get(name) ?? document.headers.get(name);

    if (under !== undefined) {
      insert(under, written);
      document.ends.set(name, under);
      continue;
    }

    // ...unless the document already says that table on a line of its own, as
    // `viewport = { width = 1280 }`. Declaring it again would define it twice,
    // and rewriting one key inside a line is not what this does -- so it is
    // refused in words that say where to look.
    if (document.assignments.has(name)) {
      throw new RecordError(
        `'${name}' is written as one line of this document, and this changes a key at a ` +
          `time -- write it as a [${name}] table, or change that line by hand`,
      );
    }

    // A table the document does not have is declared at the end of it: one
    // declared anywhere else would swallow the assignments written below it.
    const last = lines.length - 1;
    insert(last, "", `[${name}]`, written);
    document.headers.set(name, last);
    document.ends.set(name, last);
  }

  return [
    ...(inserted.get(-1) ?? []),
    ...lines.flatMap((line, at) => [
      ...(removed.has(at) ? [] : [line]),
      ...(inserted.get(at) ?? []),
    ]),
  ].join("\n").concat(ending);
}

/**
 * Where every key already written is, table by table.
 *
 * This reads a document rather than parsing one: it is looking for the line a
 * key is on, and everything it cannot make sense of it leaves alone. A value
 * spanning several lines is read past rather than understood, so that the lines
 * inside it are never mistaken for assignments of their own.
 */
function read(lines: readonly string[]): Document {
  const assignments = new Map<string, Assignment>();
  const ends = new Map<string, number>();
  const headers = new Map<string, number>();

  let table: readonly string[] = [];
  /** The delimiter of the multi-line string being read through, where there is one. */
  let quoted: '"""' | "'''" | undefined;
  let rootEnds = -1;
  let firstHeader: number | undefined;

  for (const [at, written] of lines.entries()) {
    // A carriage return ends the line rather than belonging to what the line
    // says, and it is not something a pattern for a value should have to know
    // about -- so it is taken off here and put back after whatever is written.
    const carriage = written.endsWith("\r") ? "\r" : "";
    const line = carriage === "" ? written : written.slice(0, -1);

    if (quoted !== undefined) {
      if (line.includes(quoted)) {
        quoted = undefined;
      }
      continue;
    }

    const header = /^\s*\[\s*([^[\]]+?)\s*]\s*(?:#.*)?$/.exec(line);

    if (header !== null) {
      table = pathOf(header[1] ?? "");
      headers.set(keyOf(table), at);
      firstHeader ??= at;
      continue;
    }

    // An array of tables is not somewhere a setting is written, so what is
    // under one is left alone: a path reaching inside it would rewrite a line
    // belonging to something else entirely.
    if (/^\s*\[\[/.test(line)) {
      table = [unwritable];
      continue;
    }

    const assignment = /^(\s*([A-Za-z0-9_.\-"']+)\s*=\s*)(.*)$/.exec(line);

    if (assignment === null) {
      continue;
    }

    const [, before = "", key = "", value = ""] = assignment;
    const opening = /^("""|''')/.exec(value);

    if (opening !== null) {
      const delimiter = (opening[1] ?? '"""') as '"""' | "'''";
      quoted = value.slice(delimiter.length).includes(delimiter) ? undefined : delimiter;
      continue;
    }

    const path = [...table, ...pathOf(key)];
    const note = noteAt(value);

    assignments.set(keyOf(path), {
      at,
      before,
      after: `${note === undefined ? "" : value.slice(note)}${carriage}`,
    });
    ends.set(keyOf(table), at);

    if (table.length === 0) {
      rootEnds = at;
    }
  }

  return {
    assignments,
    ends,
    headers,
    rootEnds: rootEnds >= 0 ? rootEnds : aboveTables(lines, firstHeader),
  };
}

/**
 * Where a root key goes in a document whose root says nothing yet: above the
 * first table, and below whatever the file opens with -- a document beginning
 * with a line about what the Project is keeps that line first.
 */
function aboveTables(lines: readonly string[], firstHeader: number | undefined): number {
  let at = (firstHeader ?? lines.length) - 1;

  while (at >= 0 && (lines[at] ?? "").trim() === "") {
    at--;
  }

  return at;
}

/**
 * Where a person's own note begins on the line, and the space before it, since
 * that space is the note's rather than the value's.
 */
function noteAt(value: string): number | undefined {
  let quote: '"' | "'" | undefined;

  for (let at = 0; at < value.length; at++) {
    const character = value[at];

    if (quote === '"' && character === "\\") {
      at++;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      let begins = at;
      while (begins > 0 && /\s/.test(value[begins - 1] ?? "")) {
        begins--;
      }
      return begins;
    }
  }

  return undefined;
}

/** A dotted key as the path it names, with each part unquoted. */
function pathOf(written: string): string[] {
  return written.split(".").map((part) => part.trim().replace(/^["'](.*)["']$/, "$1"));
}

/** One path as one string, spelled so that two paths cannot make the same key. */
function keyOf(path: readonly string[]): string {
  return path.join(".");
}

/**
 * One value as TOML says it.
 *
 * A string full of backslashes is written as a literal one, because
 * `"C:\Users"` is an invalid escape and `"C:\\Users"` is not what anybody
 * typed. Everything else is a basic string, whose escapes JSON's happen to be.
 */
function asToml(value: TomlValue): string {
  if (typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RecordError(`${String(value)} is not a value TOML can be written with`);
    }
    return String(value);
  }

  return value.includes("\\") && !value.includes("'") && !/\p{Cc}/u.test(value)
    ? `'${value}'`
    : JSON.stringify(value);
}
