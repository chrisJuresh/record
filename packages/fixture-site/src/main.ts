#!/usr/bin/env node
/**
 * The fixture site as its own process, serving until it is stopped.
 *
 * This is what a test's `start_command` names, so that Project lifecycle can be
 * exercised against a real server the tool starts and stops rather than one the
 * test is holding open.
 */
import { startFixtureSite } from "./serve.js";

const [port, delayMs] = process.argv.slice(2).map(Number);

if (port === undefined || !Number.isInteger(port)) {
  process.stderr.write("serve the fixture site: main.js <port> [delayMs]\n");
  process.exit(1);
}

const site = await startFixtureSite(port, delayMs ?? 0);

process.stdout.write(`${site.url}\n`);
