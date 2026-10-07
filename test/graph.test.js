import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildWhatsAppMessagesUrl } from "../graph.js";

const phoneNumberId = "000000000000001";

test("builds the reviewed default messages endpoint", () => {
  assert.equal(
    buildWhatsAppMessagesUrl({ PHONE_NUMBER_ID: phoneNumberId }),
    "https://graph.facebook.com/v25.0/000000000000001/messages",
  );
});

test("preserves an explicit version override and the supplied phone number ID", () => {
  assert.equal(
    buildWhatsAppMessagesUrl({ GRAPH_VERSION: "v21.0", PHONE_NUMBER_ID: "000000000000002" }),
    "https://graph.facebook.com/v21.0/000000000000002/messages",
  );
});

// A separate process cannot inherit the developer's .env or API credentials.
// Import before setting the environment, as index.js does before its .env loader.
function urlFromProcessEnv(version) {
  const moduleUrl = new URL("../graph.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { buildWhatsAppMessagesUrl } from ${JSON.stringify(moduleUrl)};
    process.env.PHONE_NUMBER_ID = ${JSON.stringify(phoneNumberId)};
    ${version === undefined ? "" : `process.env.GRAPH_VERSION = ${JSON.stringify(version)};`}
    process.stdout.write(buildWhatsAppMessagesUrl());
  `], { env: {}, encoding: "utf8", timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

test("uses the default with no GRAPH_VERSION and no credentials", () => {
  assert.equal(urlFromProcessEnv(), "https://graph.facebook.com/v25.0/000000000000001/messages");
});

test("reads GRAPH_VERSION from the environment after module import", () => {
  assert.equal(urlFromProcessEnv("v23.0"), "https://graph.facebook.com/v23.0/000000000000001/messages");
});

test("the example configuration does not mask the reviewed default with an old version", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(example, /^GRAPH_VERSION=v25\.0\s*$/m);
});
