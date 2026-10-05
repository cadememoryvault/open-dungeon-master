// A connection pinned to one campaign must not inherit account-wide library
// tools whose requests carry no campaignId. Hide them from discovery and
// refuse them at execution too, so an older MCP client cannot call by name.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { workbenchCall, workbenchTools } = await import("../src/lib/agents/workbench.ts");

const pinned = {
  id: "grant-1",
  userId: "user-1",
  name: "Pinned",
  scopes: ["read", "characters"],
  campaignId: "campaign-a",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  lastUsedAt: null,
  revokedAt: null,
};

const names = workbenchTools(pinned).map((tool) => tool.name);
assert.ok(names.includes("odm_whoami"));
assert.ok(names.includes("odm_get_campaign"));
for (const name of [
  "odm_list_characters",
  "odm_get_character",
  "odm_create_character",
  "odm_update_character",
  "odm_delete_character",
]) {
  assert.equal(names.includes(name), false, `${name} leaked into a campaign-pinned tool catalog`);
  const outcome = await workbenchCall(pinned, name, {
    characterId: "other-character",
    level: 1,
    sheet: {},
    confirm: true,
  });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.campaignId, pinned.campaignId);
  assert.match(outcome.text, /account-wide character library/i);
}

const unpinned = { ...pinned, id: "grant-2", campaignId: null };
const unpinnedNames = workbenchTools(unpinned).map((tool) => tool.name);
for (const name of [
  "odm_list_characters",
  "odm_get_character",
  "odm_create_character",
  "odm_update_character",
  "odm_delete_character",
]) {
  assert.equal(unpinnedNames.includes(name), true, `${name} disappeared from an account-wide grant`);
}

console.log("test-agent-campaign-pin: 10 tests passed");
