// Rule-chunk flags are campaign-scoped at the write itself: knowing a chunk
// id from another table must not let story authority mutate that table and
// only discover the mismatch after the UPDATE.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-rule-chunk-scope-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.chdir(dir);
register("./lib/register-alias.mjs", import.meta.url);

// setHouseRules embeds in the background; keep this regression independent
// of any local embedding model, as the existing route tests do.
globalThis.__odmEmbedderPromise = Promise.resolve((texts) =>
  Promise.resolve({ tolist: () => texts.map(() => new Array(384).fill(0.1)) }),
);

const { getDatabase } = await import("../src/lib/db/core.ts");
const { createUser } = await import("../src/lib/db/users.ts");
const { createCampaign } = await import("../src/lib/db/campaigns.ts");
const { listRuleChunks, setHouseRules, setRuleChunkFlags } = await import("../src/lib/db/rules.ts");

const db = getDatabase();
const owner = createUser("owner", "hash");
const table = (title) => ({
  title,
  description: "",
  theme: "",
  maxPlayers: 4,
  startingLevel: 1,
  difficulty: "normal",
});
const first = createCampaign(owner.id, table("First"));
const second = createCampaign(owner.id, table("Second"));

setHouseRules(first.id, "# First rule\nPotions are a bonus action.");
setHouseRules(second.id, "# Second rule\nCritical hits use maximum damage.");

const firstChunk = listRuleChunks(first.id)[0];
const secondChunk = listRuleChunks(second.id)[0];
assert.ok(firstChunk && secondChunk);

const refused = setRuleChunkFlags(first.id, secondChunk.id, { enabled: false, pinned: true });
assert.equal(refused, null, "a chunk from another campaign must not be writable");

const secondAfterRefusal = listRuleChunks(second.id)[0];
assert.equal(secondAfterRefusal.enabled, true, "foreign chunk enabled flag changed");
assert.equal(secondAfterRefusal.pinned, false, "foreign chunk pinned flag changed");

const own = setRuleChunkFlags(first.id, firstChunk.id, { enabled: false, pinned: true });
assert.ok(own);
assert.equal(own.campaignId, first.id);
assert.equal(own.enabled, false);
assert.equal(own.pinned, true);

const firstAfter = listRuleChunks(first.id)[0];
assert.equal(firstAfter.enabled, false);
assert.equal(firstAfter.pinned, true);

const foreign = db
  .prepare("SELECT enabled, pinned FROM rule_chunks WHERE id = ? AND campaign_id = ?")
  .get(secondChunk.id, second.id);
assert.deepEqual(foreign, { enabled: 1, pinned: 0 });

db.close();
removeTempDir(dir);
console.log("test-rule-chunk-scope: 1 test passed");
