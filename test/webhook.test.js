import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Exercise the real server and .env loader. All external fetch calls are
// replaced in the child; only a loopback HTTP request reaches a real socket.
const preload = `
const { Server } = require("node:http");
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once("listening", () => process.send({ port: this.address().port }));
  return listen.apply(this, args);
};
globalThis.fetch = async (url, options) => {
  const host = new URL(url).hostname;
  if (host !== "graph.facebook.com" && host !== "api.anthropic.com") {
    throw new Error("Unexpected external URL: " + url);
  }
  process.send({ url, method: options.method, headers: options.headers,
    body: JSON.parse(options.body) });
  return { ok: true, json: async () => ({ content: [{ text: "Test reply" }] }) };
};
`;

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/webhook", method: "POST",
      headers: { "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
}

for (const scenario of [
  { name: "default", file: "", env: {}, version: "v25.0" },
  { name: ".env override", file: "GRAPH_VERSION=v23.0\n", env: {}, version: "v23.0" },
  { name: "environment overrides .env", file: "GRAPH_VERSION=v25.0\n",
    env: { GRAPH_VERSION: "v21.0" }, version: "v21.0" },
]) {
  test(`both WhatsApp operations use the ${scenario.name}`, { timeout: 10000 }, async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "whatsapp-graph-test-"));
    const mockPath = join(cwd, "mock.cjs");
    writeFileSync(mockPath, preload);
    writeFileSync(join(cwd, ".env"), scenario.file);
    const child = fork(fileURLToPath(new URL("../index.js", import.meta.url)), [], {
      cwd, execArgv: ["--require", mockPath], silent: true,
      env: { PORT: "0", WHATSAPP_TOKEN: "fake-whatsapp-token",
        PHONE_NUMBER_ID: "000000000000001", VERIFY_TOKEN: "fake-verify-token",
        ANTHROPIC_API_KEY: "fake-anthropic-key", ...scenario.env },
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      rmSync(cwd, { recursive: true, force: true });
    });
    const calls = [];
    let resolveReply;
    const replied = new Promise((resolve) => { resolveReply = resolve; });
    child.on("message", (message) => {
      if (!message.url) return;
      calls.push(message);
      if (message.body.type === "text") resolveReply();
    });
    const [{ port }] = await once(child, "message");
    assert.ok(port);

    // v24+ status payloads may omit conversation. They must still be ignored.
    assert.equal(await post(port, { entry: [{ changes: [{ value: {
      statuses: [{ id: "wamid.test", status: "delivered" }],
    } }] }] }), 200);
    assert.equal(calls.length, 0);

    assert.equal(await post(port, { entry: [{ changes: [{ value: { messages: [{
      id: "wamid.test", from: "15555550123", type: "text", text: { body: "Hello" },
    }] } }] }] }), 200);
    await replied;
    assert.equal(calls.length, 3);
    const [read, claude, reply] = calls;
    assert.equal(claude.url, "https://api.anthropic.com/v1/messages");
    for (const call of [read, reply]) {
      assert.equal(call.url, `https://graph.facebook.com/${scenario.version}/000000000000001/messages`);
      assert.equal(call.method, "POST");
      assert.equal(call.headers.Authorization, "Bearer fake-whatsapp-token");
      assert.equal(call.headers["Content-Type"], "application/json");
    }
    assert.deepEqual(read.body, { messaging_product: "whatsapp", status: "read", message_id: "wamid.test" });
    assert.deepEqual(reply.body, { messaging_product: "whatsapp", to: "15555550123",
      recipient_type: "individual", type: "text", text: { body: "Test reply" } });
  });
}
