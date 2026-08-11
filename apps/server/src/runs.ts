/**
 * The Runs this server has been asked for, and what each of them has said about
 * itself so far.
 *
 * A request to record answers immediately and its Runs go on without it,
 * because a Run takes long enough that holding a connection open for it would
 * be indistinguishable from a hang. What they say on the way through is kept
 * here and handed to whoever is watching -- and kept for whoever starts
 * watching late, so a client that connected a moment after asking is not shown
 * a Run that appears to have done nothing.
 */
import { randomUUID } from "node:crypto";

/**
 * How many asked-for Runs are remembered. Enough that a session's worth of
 * recording is all still readable, and bounded so a server left running does
 * not grow without end.
 */
const rememberedRequests = 50;

/** Whether a request to record is still going, and how it ended if it is not. */
export type RunState = "running" | "recorded" | "failed";

/** One request to record, as a client reads it. */
export type RunRequest = {
  readonly id: string;
  /** The command's words, so what was asked for is readable rather than inferred. */
  readonly words: readonly string[];
  readonly state: RunState;
  readonly askedAt: string;
  readonly endedAt: string | null;
  /** Everything the Runs have said about themselves so far, in order. */
  readonly progress: readonly unknown[];
  /** What the command answered with, once it has answered. */
  readonly report: unknown;
  /** What stopped it, in the command's own words. */
  readonly message: string | null;
};

/** What a watcher is told: each progress as it happens, then how it ended. */
export type RunEvent =
  | { readonly kind: "progress"; readonly progress: unknown }
  | { readonly kind: "ended"; readonly request: RunRequest };

export type RunRegistry = {
  /** Remembers a request that is about to be made, and names it. */
  begin(words: readonly string[]): RunRequest;
  /** Keeps what a Run said, and tells whoever is watching. */
  progress(id: string, event: unknown): void;
  /** Settles how it ended, and tells whoever is watching before letting them go. */
  end(id: string, how: { state: RunState; report: unknown; message: string | null }): void;
  /**
   * Watches one request, and stops watching when the returned function is
   * called. A request that has already ended tells its watcher so at once
   * rather than leaving it waiting for an event that has been and gone.
   */
  watch(id: string, watcher: (event: RunEvent) => void): () => void;
  read(id: string): RunRequest | undefined;
  /** Every request still remembered, most recently asked for first. */
  all(): readonly RunRequest[];
};

/** One remembered request, as this registry keeps it rather than as it is read. */
type Entry = {
  readonly id: string;
  readonly words: readonly string[];
  readonly askedAt: string;
  readonly progress: unknown[];
  readonly watchers: Set<(event: RunEvent) => void>;
  state: RunState;
  endedAt: string | null;
  report: unknown;
  message: string | null;
};

export function runRegistry(): RunRegistry {
  const entries = new Map<string, Entry>();

  const forget = (): void => {
    // The oldest go first, and only ones that have ended: a Run still recording
    // is one somebody is waiting on however long the queue behind it.
    const ended = [...entries.values()].filter((entry) => entry.state !== "running");

    for (const entry of ended.slice(0, Math.max(0, entries.size - rememberedRequests))) {
      entries.delete(entry.id);
    }
  };

  return {
    begin(words) {
      const entry: Entry = {
        id: randomUUID(),
        words: [...words],
        askedAt: new Date().toISOString(),
        progress: [],
        watchers: new Set(),
        state: "running",
        endedAt: null,
        report: undefined,
        message: null,
      };

      entries.set(entry.id, entry);
      forget();

      return read(entry);
    },

    progress(id, event) {
      const entry = entries.get(id);

      if (entry === undefined) {
        return;
      }

      entry.progress.push(event);
      tell(entry, { kind: "progress", progress: event });
    },

    end(id, how) {
      const entry = entries.get(id);

      if (entry === undefined) {
        return;
      }

      entry.state = how.state;
      entry.report = how.report;
      entry.message = how.message;
      entry.endedAt = new Date().toISOString();

      tell(entry, { kind: "ended", request: read(entry) });
      entry.watchers.clear();
    },

    watch(id, watcher) {
      const entry = entries.get(id);

      if (entry === undefined) {
        return () => undefined;
      }

      // Everything it has already said, so that watching from halfway through
      // still shows the whole Run.
      for (const event of entry.progress) {
        watcher({ kind: "progress", progress: event });
      }

      if (entry.state !== "running") {
        watcher({ kind: "ended", request: read(entry) });
        return () => undefined;
      }

      entry.watchers.add(watcher);

      return () => entry.watchers.delete(watcher);
    },

    read(id) {
      const entry = entries.get(id);

      return entry === undefined ? undefined : read(entry);
    },

    all() {
      return [...entries.values()].reverse().map(read);
    },
  };
}

/** One entry as a client reads it, which is a copy rather than the entry itself. */
function read(entry: Entry): RunRequest {
  return {
    id: entry.id,
    words: [...entry.words],
    state: entry.state,
    askedAt: entry.askedAt,
    endedAt: entry.endedAt,
    progress: [...entry.progress],
    report: entry.report,
    message: entry.message,
  };
}

/**
 * Tells every watcher, and lets one that has gone away take nothing down with
 * it -- a client that closed its connection mid-Run must not fail the Run.
 */
function tell(entry: Entry, event: RunEvent): void {
  for (const watcher of [...entry.watchers]) {
    try {
      watcher(event);
    } catch {
      entry.watchers.delete(watcher);
    }
  }
}
