// Persistent table mutes apply to the voice plane as well as text actions:
// a muted member may still read the table/transcript, but may not join or
// publish voice and may not submit durable transcript audio.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-voice-mute-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.VOICE_ENABLED = "1";
process.chdir(dir);
register("./lib/register-routes.mjs", import.meta.url);

const { createUser } = await import("../src/lib/db/users.ts");
const { createCampaign, joinByInviteCode } = await import("../src/lib/db/campaigns.ts");
const { mintSession } = await import("../src/lib/auth.ts");
const { requireVoiceMember } = await import("../src/lib/voice/gate.ts");
const { meshJoin, meshJoined } = await import("../src/lib/voice/mesh.ts");
const transcriptRoute = await import(
  new URL("../src/app/api/campaigns/[campaignId]/voice/transcript/route.ts", import.meta.url).href
);
const muteRoute = await import(
  new URL("../src/app/api/campaigns/[campaignId]/mute/route.ts", import.meta.url).href
);

const lead = createUser("lead", "hash");
const player = createUser("player", "hash");
const campaign = createCampaign(lead.id, {
  title: "Voice table",
  description: "",
  theme: "",
  maxPlayers: 4,
  startingLevel: 1,
  difficulty: "normal",
  gameSettings: { voice: { enabled: true, transcribe: true } },
});
joinByInviteCode(player.id, campaign.inviteCode);
globalThis.__odmTestToken = mintSession(player.id).token;

const before = await requireVoiceMember(campaign.id);
assert.equal(before instanceof Response, false, "an unmuted member should pass the voice gate");

meshJoin(campaign.id, player.id, player.username);
assert.equal(meshJoined(campaign.id, player.id), true);

globalThis.__odmTestToken = mintSession(lead.id).token;
const muted = await muteRoute.POST(
  new Request("http://test/mute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: player.id, muted: true }),
  }),
  { params: Promise.resolve({ campaignId: campaign.id }) },
);
assert.equal(muted.status, 200);
assert.equal(meshJoined(campaign.id, player.id), false, "a live muted peer remained on the call");

globalThis.__odmTestToken = mintSession(player.id).token;
const gated = await requireVoiceMember(campaign.id);
assert.equal(gated instanceof Response, true);
assert.equal(gated.status, 403);
assert.match((await gated.json()).error, /muted/i);

const posted = await transcriptRoute.POST(
  new Request("http://test/transcript", { method: "POST" }),
  { params: Promise.resolve({ campaignId: campaign.id }) },
);
assert.equal(posted.status, 403, "a muted member submitted transcript audio");
assert.match((await posted.json()).error, /muted/i);

const read = await transcriptRoute.GET(
  new Request("http://test/transcript"),
  { params: Promise.resolve({ campaignId: campaign.id }) },
);
assert.equal(read.status, 200, "mute should not remove read access");
assert.deepEqual((await read.json()).lines, []);

globalThis.__odmTestToken = mintSession(lead.id).token;
const unmuted = await muteRoute.POST(
  new Request("http://test/mute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: player.id, muted: false }),
  }),
  { params: Promise.resolve({ campaignId: campaign.id }) },
);
assert.equal(unmuted.status, 200);

globalThis.__odmTestToken = mintSession(player.id).token;
const after = await requireVoiceMember(campaign.id);
assert.equal(after instanceof Response, false, "unmuting should restore permission to rejoin");

removeTempDir(dir);
console.log("test-voice-mute-gate: 5 tests passed");
