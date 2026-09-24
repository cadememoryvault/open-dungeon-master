// Audit-only regression probes for contribution triage.
// These are deliberately written against the behaviour we WANT. On the
// reviewed upstream baseline they should fail until the candidate defects are
// fixed. Keep this file on the audit branch; do not submit it upstream as-is.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "odm-audit-worlds-"));
process.env.WORLD_PACKS_DIR = scratch;

const {
  installFromUrl,
  removeWorldPack,
} = await import("../src/lib/worlds/install.ts");
const {
  resetWorldPackCache,
  worldPack,
} = await import("../src/lib/worlds/index.ts");

const failures = [];
let passed = 0;

async function probe(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

function manifest(id) {
  return {
    id,
    name: "Audit World",
    blurb: "Only used by the contribution audit.",
    inspiredBy: "Nothing.",
    franchise: "Audit",
    baseGenre: "high_fantasy",
    theme: "A bounded audit fixture",
  };
}

function jsonResponse(value, extras = {}) {
  const body = new Response(JSON.stringify(value)).body;
  return {
    ok: true,
    status: 200,
    body,
    redirected: false,
    url: "https://registry.example.invalid/world.json",
    ...extras,
  };
}

const realFetch = globalThis.fetch;

await probe("registry id mismatch is rejected before any pack is written", async () => {
  globalThis.fetch = async () => jsonResponse(manifest("different_world"));
  resetWorldPackCache();

  const result = await installFromUrl(
    "https://registry.example.invalid/expected_world.json",
    "expected_world",
  );

  assert.equal(result.ok, false, "mismatched registry id should be rejected");
  assert.equal(
    worldPack("different_world"),
    null,
    "a failed expected-id integrity check must not leave the mismatched pack installed",
  );

  await removeWorldPack("different_world");
});

await probe("HTTPS-only world fetch policy survives redirects", async () => {
  globalThis.fetch = async (_url, options) => {
    assert.equal(
      options?.redirect,
      "follow",
      "audit assumes the current implementation follows redirects automatically",
    );
    return jsonResponse(manifest("redirect_world"), {
      redirected: true,
      url: "http://127.0.0.1/internal/redirect_world.json",
    });
  };
  resetWorldPackCache();

  const result = await installFromUrl(
    "https://registry.example.invalid/redirect_world.json",
    "redirect_world",
  );

  assert.equal(
    result.ok,
    false,
    "an HTTPS-only downloader should reject a final response whose URL downgraded to HTTP",
  );
  assert.equal(
    worldPack("redirect_world"),
    null,
    "a downgraded redirect must not install content",
  );

  await removeWorldPack("redirect_world");
});

await probe("test-world-install reports and cleans up only after its final test", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "test-world-install.mjs"), "utf8");
  const lastTest = source.lastIndexOf("await test(");
  const cleanup = source.indexOf("removeTempDir(scratch)");
  const report = source.indexOf("console.log(`test-world-install:");

  assert.ok(lastTest >= 0, "expected at least one test");
  assert.ok(cleanup > lastTest, "scratch cleanup currently happens before the final test");
  assert.ok(report > lastTest, "pass-count reporting currently happens before the final test");
});

globalThis.fetch = realFetch;
resetWorldPackCache();
fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\nAudit probes: ${passed} passed, ${failures.length} failed.`);
if (failures.length) {
  process.exit(1);
}
