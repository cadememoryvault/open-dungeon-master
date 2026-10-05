// Uploaded media follows its durable references across account avatars,
// campaign covers and NPC portraits. A file is removed only after the final
// row anywhere in the database stops naming it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const repoCwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-media-reference-cleanup-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const uploadsDir = path.join(dir, "public", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
process.chdir(dir);

register("./lib/register-alias.mjs", import.meta.url);

const { createUser, getUserById, setUserAvatar } = await import("../src/lib/db/users.ts");
const { createCampaign, getCampaignById, setCampaignCover } = await import("../src/lib/db/campaigns.ts");
const {
  deleteNpc,
  getNpcById,
  mergeNpcs,
  setNpcPortrait,
  upsertNpc,
} = await import("../src/lib/db/npcs.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

function touch(name) {
  fs.writeFileSync(path.join(uploadsDir, name), "png");
}

function exists(name) {
  return fs.existsSync(path.join(uploadsDir, name));
}

const user = createUser("media-owner", "hash");
const campaign = createCampaign(user.id, {
  title: "Media lifecycle",
  description: "",
  theme: "",
  maxPlayers: 4,
  startingLevel: 1,
  difficulty: "normal",
});

test("replacing an avatar removes the old unreferenced upload", () => {
  touch("avatar-old.png");
  touch("avatar-new.png");
  setUserAvatar(user.id, { url: "/uploads/avatar-old.png" });
  setUserAvatar(user.id, { url: "/uploads/avatar-new.png" });
  assert.equal(getUserById(user.id)?.avatar?.url, "/uploads/avatar-new.png");
  assert.equal(exists("avatar-old.png"), false);
  assert.equal(exists("avatar-new.png"), true);
});

test("a file shared by avatar and cover survives until both references are gone", () => {
  touch("shared.png");
  setUserAvatar(user.id, { url: "/uploads/shared.png" });
  assert.equal(setCampaignCover(campaign.id, { id: "shared", url: "/uploads/shared.png" }), true);

  setUserAvatar(user.id, null);
  assert.equal(exists("shared.png"), true);
  assert.equal(getCampaignById(campaign.id)?.cover?.url, "/uploads/shared.png");

  assert.equal(setCampaignCover(campaign.id, null), true);
  assert.equal(exists("shared.png"), false);
});

test("replacing and deleting an NPC portrait retire unique uploads", () => {
  const npc = upsertNpc({ campaignId: campaign.id, name: "Marla" });
  touch("npc-old.png");
  touch("npc-new.png");

  assert.equal(setNpcPortrait(npc.id, "/uploads/npc-old.png")?.portraitUrl, "/uploads/npc-old.png");
  assert.equal(setNpcPortrait(npc.id, "/uploads/npc-new.png")?.portraitUrl, "/uploads/npc-new.png");
  assert.equal(exists("npc-old.png"), false);
  assert.equal(exists("npc-new.png"), true);

  assert.equal(deleteNpc(npc.id), true);
  assert.equal(getNpcById(npc.id), null);
  assert.equal(exists("npc-new.png"), false);
});

test("merging NPCs keeps a shared portrait until the keeper is deleted", () => {
  const keep = upsertNpc({ campaignId: campaign.id, name: "Keeper" });
  const merge = upsertNpc({ campaignId: campaign.id, name: "Duplicate" });
  touch("npc-shared.png");
  setNpcPortrait(keep.id, "/uploads/npc-shared.png");
  setNpcPortrait(merge.id, "/uploads/npc-shared.png");

  const merged = mergeNpcs(campaign.id, keep.id, merge.id, ["Keeper", "Duplicate"]);
  assert.equal(merged?.id, keep.id);
  assert.equal(getNpcById(merge.id), null);
  assert.equal(exists("npc-shared.png"), true);

  assert.equal(deleteNpc(keep.id), true);
  assert.equal(exists("npc-shared.png"), false);
});

console.log(`\n${passed} media reference cleanup checks passed.`);
process.chdir(repoCwd);
removeTempDir(dir);
