/**
 * Finding `chrome-headless-shell`. Per ADR 0008 it must be the old headless
 * binary rather than `chrome.exe`, and Playwright's browser download is where
 * the pinned copy comes from -- Playwright supplies the binary, not the driver.
 */
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { RecordError } from "./errors.js";

type Location = {
  /** Directory Playwright downloads browsers into. */
  readonly cache: string;
  /** Path of the executable within one downloaded browser directory. */
  readonly executable: string;
};

const locations: Partial<Record<NodeJS.Platform, Location>> = {
  win32: {
    cache: join(process.env["LOCALAPPDATA"] ?? homedir(), "ms-playwright"),
    executable: join("chrome-headless-shell-win64", "chrome-headless-shell.exe"),
  },
  darwin: {
    cache: join(homedir(), "Library", "Caches", "ms-playwright"),
    executable: join("chrome-headless-shell-mac", "chrome-headless-shell"),
  },
};

const install = "install it with `npx playwright install chromium-headless-shell`, " +
  "or name a copy in $RECORD_CHROME";

/**
 * The `chrome-headless-shell` this machine records with. `$RECORD_CHROME`
 * names one explicitly; otherwise the newest of Playwright's downloads is used.
 */
export async function findHeadlessShell(): Promise<string> {
  const named = process.env["RECORD_CHROME"];
  if (named !== undefined && named !== "") {
    if (!(await isReadable(named))) {
      throw new RecordError(`$RECORD_CHROME names ${named}, which is not there`);
    }
    return named;
  }

  const location = locations[process.platform];
  if (location === undefined) {
    throw new RecordError(
      `no chrome-headless-shell location is known for ${process.platform}; ${install}`,
    );
  }

  const downloads = await readdir(location.cache).catch(() => [] as string[]);
  const builds = downloads
    .filter((entry) => entry.startsWith("chromium_headless_shell-"))
    .sort((left, right) => buildNumber(left) - buildNumber(right));

  for (const build of builds.reverse()) {
    const executable = join(location.cache, build, location.executable);
    if (await isReadable(executable)) {
      return executable;
    }
  }

  throw new RecordError(`no chrome-headless-shell found under ${location.cache}; ${install}`);
}

function buildNumber(directory: string): number {
  return Number(directory.slice("chromium_headless_shell-".length)) || 0;
}

async function isReadable(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}
