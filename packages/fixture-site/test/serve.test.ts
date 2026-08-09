/**
 * The fixture site is what every other test records against, so a broken
 * harness would quietly weaken the suites that depend on it. These tests cover
 * the harness itself; product behaviour is asserted at the two seams.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { startFixtureSite } from "../src/serve.js";

const site = await startFixtureSite();
after(() => site.close());

test("serves the fixture site on an ephemeral port", async () => {
  assert.match(site.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const response = await fetch(site.url);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>record fixture site<\/title>/);
});

test("two harnesses run side by side on ports of their own", async () => {
  const other = await startFixtureSite();
  try {
    assert.notEqual(other.url, site.url);
    assert.equal((await fetch(other.url)).status, 200);
  } finally {
    await other.close();
  }
});

test("serves nothing from outside the fixture site", async () => {
  const escapes = ["..%2f..%2fpackage.json", "%2e%2e/%2e%2e/package.json", "site/../../package.json"];

  for (const escape of escapes) {
    const response = await fetch(`${site.url}${escape}`);
    assert.equal(response.status, 404, `expected 404 for ${escape}`);
  }
});
