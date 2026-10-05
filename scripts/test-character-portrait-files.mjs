// Character portrait files follow their database references: replacement and
// deletion remove only files that no surviving row still names.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const repoCwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-character-portrait-files-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const uploadsDir = path.join(dir, "public", "uploads");
const generatedDir = path.join(dir, "public", "generated");
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(generatedDir, { recursive: true });
process.chdir(dir);

register("./lib/register-alias.mjs", import.meta.url);

const { getDatabase } = await import("../src/lib/db/core.ts");
const { createUser } = await import("../src/lib/db/users.ts");
const { createCampaign } = await import("../src/lib/db/campaigns.ts");
const { createSheet, deleteSheetForUser, patchSheet } = await import("../src/lib/db/sheets.ts");
const { deleteCharacter, updateCharacterPortrait } = await import("../src/lib/db/characters.ts");
const { copyIntoUploads } = await import("../src/lib/portrait.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

const db = getDatabase();
const user = createUser("portraits", "hash");
const now = new Date().toISOString();

function portrait(url) {
  return { id: path.basename(url, path.extname(url)), name: "portrait", type: "image/png", url };
}

function addCharacter(id, url) {
  db.prepare(
    `INSERT INTO library_characters (
       id, user_id, name, race, class, sheet_json, created_at, updated_at
     ) VALUES (?, ?, ?, 'human', 'fighter', ?, ?, ?)`,
  ).run(id, user.id, id, JSON.stringify({ portrait: portrait(url) }), now, now);
}

function touch(name) {
  fs.writeFileSync(path.join(uploadsDir, name), "png");
}

function sheetInput(name, url) {
  return {
    name,
    race: "human",
    class: "fighter",
    subclass: "",
    background: "",
    alignment: "",
    gender: "",
    appearance: "",
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    maxHp: 10,
    ac: 10,
    acOverride: true,
    speed: 30,
    hitDice: { die: "d10", total: 1, spent: 0 },
    classes: [],
    hitDicePools: null,
    proficiencies: {
      saves: [],
      skills: [],
      expertise: [],
      languages: ["Common"],
      tools: [],
      armor: [],
      weapons: [],
    },
    equipment: [],
    gold: 0,
    copper: 0,
    feats: [],
    features: [],
    asiChoices: [],
    spellcasting: null,
    portrait: url ? portrait(url) : null,
    notes: "",
    backstory: "",
  };
}

test("copying a generated portrait removes its unreferenced staging file", () => {
  fs.writeFileSync(path.join(generatedDir, "staged.png"), "png");
  const copied = copyIntoUploads("/generated/staged.png");
  assert.equal(fs.existsSync(path.join(generatedDir, "staged.png")), false);
  assert.equal(fs.existsSync(path.join(dir, "public", copied.url)), true);
});

test("replacing a unique library portrait removes the old file", () => {
  touch("old.png");
  touch("new.png");
  addCharacter("replace", "/uploads/old.png");
  const updated = updateCharacterPortrait(user.id, "replace", portrait("/uploads/new.png"));
  assert.equal(updated?.sheet.portrait?.url, "/uploads/new.png");
  assert.equal(fs.existsSync(path.join(uploadsDir, "old.png")), false);
  assert.equal(fs.existsSync(path.join(uploadsDir, "new.png")), true);
});

test("a shared portrait stays until the last character stops naming it", () => {
  touch("shared.png");
  addCharacter("shared-a", "/uploads/shared.png");
  addCharacter("shared-b", "/uploads/shared.png");

  updateCharacterPortrait(user.id, "shared-a", null);
  assert.equal(fs.existsSync(path.join(uploadsDir, "shared.png")), true);

  assert.equal(deleteCharacter(user.id, "shared-b"), true);
  assert.equal(fs.existsSync(path.join(uploadsDir, "shared.png")), false);
});

test("deleting a character removes its otherwise-unreferenced portrait", () => {
  touch("delete-me.png");
  addCharacter("delete", "/uploads/delete-me.png");
  assert.equal(deleteCharacter(user.id, "delete"), true);
  assert.equal(fs.existsSync(path.join(uploadsDir, "delete-me.png")), false);
});

const campaign = createCampaign(user.id, {
  title: "Portrait cleanup",
  description: "",
  theme: "",
  maxPlayers: 4,
  startingLevel: 1,
  difficulty: "normal",
});

test("replacing a campaign-sheet portrait removes the old file", () => {
  touch("sheet-old.png");
  touch("sheet-new.png");
  const sheet = createSheet(
    campaign.id,
    user.id,
    1,
    sheetInput("Sheet replace", "/uploads/sheet-old.png"),
  );
  const updated = patchSheet(sheet.id, { portrait: portrait("/uploads/sheet-new.png") });
  assert.equal(updated?.portrait?.url, "/uploads/sheet-new.png");
  assert.equal(fs.existsSync(path.join(uploadsDir, "sheet-old.png")), false);
  assert.equal(fs.existsSync(path.join(uploadsDir, "sheet-new.png")), true);
  deleteSheetForUser(campaign.id, user.id);
});

test("deleting a campaign sheet removes its otherwise-unreferenced portrait", () => {
  touch("sheet-delete.png");
  createSheet(
    campaign.id,
    user.id,
    1,
    sheetInput("Sheet delete", "/uploads/sheet-delete.png"),
  );
  assert.ok(deleteSheetForUser(campaign.id, user.id));
  assert.equal(fs.existsSync(path.join(uploadsDir, "sheet-delete.png")), false);
});

console.log(`\n${passed} character portrait file checks passed.`);
process.chdir(repoCwd);
removeTempDir(dir);
