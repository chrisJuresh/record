#!/usr/bin/env node
/**
 * The fixture site as its own process, serving until it is stopped.
 *
 * This is what a test's `start_command` names, so that Project lifecycle can be
 * exercised against a real server the tool starts and stops rather than one the
 * test is holding open.
 */
import { setTimeout as delay } from "node:timers/promises";

import { startFixtureSite } from "./serve.js";

const [port, delayMs = 0] = process.argv.slice(2).map(Number);

if (port === undefined || !Number.isInteger(port) || !Number.isInteger(delayMs)) {
  process.stderr.write("serve the fixture site: main.js <port> [delayMs]\n");
  process.exit(1);
}

// A Project that takes a moment to come up is the case worth exercising: the
// tool has to wait for the ready URL rather than take the command's word.
await delay(delayMs);

const site = await startFixtureSite(port);

process.stdout.write(`${site.url}\n`);
