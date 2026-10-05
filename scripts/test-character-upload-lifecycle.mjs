// Character portrait files follow their database references: replacing or
// deleting a character removes the old upload only after the last reference
// is gone, and account deletion sees portraits stored in library sheet_json.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-character-files-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const uploadsDir = path.join(dir, "public", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
process.chdir(dir);

register("./lib/register-routes.mjs", import.meta.url);

const { getDatabase } = await import("../src/lib/db/core.ts");
const { createUser } = await import("../src/lib/db/users.ts");
const { mintSession } = await import("../src/lib/auth.ts");
const { purgeAccount } = await import("../src/lib/account-deletion.ts");
const characterRoute = await import(
  new URL("../src/app/api/characters/[characterId]/route.ts", import.meta.url).href
);

const db = getDatabase();
const now = new Date().toISOString();
const alice = createUser("alice", "hash");
const bob = createUser("bob", "hash");

function insertCharacter(id, userId, portraitUrl) {
  const sheet = {
    name: id,
    race: "human",
    class: "fighter",
    portrait: portraitUrl ? { url: portraitUrl } : null,
  };
  db.prepare(
    `INSERT INTO library_characters
       (id, user_id, name, race, class, sheet_json, portrait_json, created_at, updated_at)
     VALUES (?, ?, ?, 'human', 'fighter', ?, NULL, ?, ?)`,
  ).run(id, userId, id, JSON.stringify(sheet), now, now);
}

function write(name) {
  fs.writeFileSync(path.join(uploadsDir, name), "image");
}
function exists(name) {
  return fs.existsSync(path.join(uploadsDir, name));
}
function as(user) {
  globalThis.__odmTestToken = mintSession(user.id).token;
}
async function call(method, characterId, body) {
  const request = new Request("http://test/", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await characterRoute[method](request, {
    params: Promise.resolve({ characterId }),
  });
  return { status: response.status, json: await response.json() };
}

write("shared.png");
write("new.png");
insertCharacter("first", alice.id, "/uploads/shared.png");
insertCharacter("second", alice.id, "/uploads/shared.png");

as(alice);
const replaced = await call("PATCH", "first", { portrait: { url: "/uploads/new.png" } });
assert.equal(replaced.status, 200);
assert.equal(replaced.json.character.sheet.portrait.url, "/uploads/new.png");
assert.equal(exists("shared.png"), true, "a portrait another character still uses was deleted");
assert.equal(exists("new.png"), true);

const deleteShared = await call("DELETE", "second");
assert.equal(deleteShared.status, 200);
assert.equal(exists("shared.png"), false, "the last reference to the old portrait left an orphan");

const deleteNew = await call("DELETE", "first");
assert.equal(deleteNew.status, 200);
assert.equal(exists("new.png"), false, "deleting the final character left its portrait behind");

// Current library rows store portraits inside sheet_json. Keep portrait_json
// NULL to prove account deletion does not rely on the legacy column.
write("account.png");
insertCharacter("account-character", bob.id, "/uploads/account.png");
assert.equal(
  db.prepare("SELECT portrait_json FROM library_characters WHERE id = ?").get("account-character").portrait_json,
  null,
);
purgeAccount(bob.id);
assert.equal(exists("account.png"), false, "account purge missed the sheet_json portrait");

db.close();
removeTempDir(dir);
console.log("test-character-upload-lifecycle: 3 tests passed");
