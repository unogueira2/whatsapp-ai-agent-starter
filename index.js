// ─────────────────────────────────────────────────────────────
// index.js — WhatsApp Cloud API → Claude → WhatsApp
// ─────────────────────────────────────────────────────────────
// Receives Meta webhooks, answers with Claude, replies over the
// WhatsApp Cloud API. Zero dependencies beyond Express.
// ─────────────────────────────────────────────────────────────

import express from "express";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { getHistory, addTurn } from "./memory.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { buildWhatsAppMessagesUrl } from "./graph.js";

// ── .env loader ────────────────────────────────────────────
// Deliberately hand-rolled instead of pulling in `dotenv`: one
// less dependency in a service that already has only one, and it
// lets real environment variables win over the file (which is
// what you want on Railway/Fly/Render, where there is no .env).
try {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    // Strip surrounding quotes — pasting a token from a dashboard
    // often brings them along.
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // No .env file — expecting real environment variables.
}

// ── Config ─────────────────────────────────────────────────
const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  APP_SECRET,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-haiku-4-5-20251001",
  PORT = "3000",
} = process.env;

const required = { WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, ANTHROPIC_API_KEY };
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`\n✗ Missing required env vars: ${missing.join(", ")}`);
  console.error("  Copy .env.example to .env and fill it in.\n");
  process.exit(1);
}

if (!APP_SECRET) {
  console.warn("⚠ APP_SECRET not set — webhook signatures are NOT being verified.");
  console.warn("  Fine for local testing. Do not ship to production like this.");
}

const GRAPH_URL = buildWhatsAppMessagesUrl();

const app = express();
// Keep the raw body around — signature verification needs the exact
// bytes Meta signed, not a re-serialized object.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ── Helpers ────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Verify the X-Hub-Signature-256 header against APP_SECRET.
 * Without this, anyone who learns your webhook URL can make the
 * bot say whatever they want and burn your Anthropic credits.
 */
function verifySignature(req) {
  if (!APP_SECRET) return true; // explicitly opted out, warned at boot
  const received = req.get("x-hub-signature-256");
  if (!received || !req.rawBody) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — check first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Delay proportional to reply length, so it doesn't answer inhumanly fast. */
const humanDelay = (text) => Math.min(6000, 800 + text.length * 25);

/**
 * Split a long reply into at most 3 messages of ~300 chars,
 * breaking on sentence boundaries.
 */
function splitMessage(text) {
  if (text.length <= 300) return [text];

  const chunks = [];
  let current = "";

  for (const sentence of text.split(". ")) {
    const piece = current ? `. ${sentence}` : sentence;
    if ((current + piece).length > 280 && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += piece;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.slice(0, 3);
}

async function markAsRead(messageId) {
  try {
    await fetch(GRAPH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  } catch (err) {
    // Non-fatal: a missing read receipt is not worth dropping the reply.
    console.error("[markAsRead]", err.message);
  }
}

async function sendWhatsApp(to, text) {
  const res = await fetch(GRAPH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      recipient_type: "individual",
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  }
}

async function askClaude(history, userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [...history, { role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

// ── Webhook: verification handshake (GET) ──────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[webhook] verified ✓");
    return res.status(200).send(challenge);
  }

  console.warn("[webhook] verification failed — bad token");
  return res.sendStatus(403);
});

// ── Webhook: incoming messages (POST) ──────────────────────
app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) {
    console.warn("[webhook] bad signature — rejected");
    return res.sendStatus(403);
  }

  // Ack immediately. Meta retries anything it doesn't get a fast
  // 200 for, and a retry storm means duplicate replies.
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    if (!value?.messages) return;        // status callback (delivered/read)
    const msg = value.messages[0];
    if (msg.type !== "text") return;     // images/audio/etc. not handled

    const from = msg.from;
    const text = msg.text.body;

    console.log(`[in]  ${from}: ${text}`);

    await markAsRead(msg.id);

    const reply = await askClaude(getHistory(from), text);
    console.log(`[out] ${from}: ${reply}`);

    await sleep(humanDelay(reply));

    const chunks = splitMessage(reply);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(1000 + Math.random() * 1500);
      await sendWhatsApp(from, chunks[i]);
    }

    // Only record the turn once it actually went out.
    addTurn(from, "user", text);
    addTurn(from, "assistant", reply);
  } catch (err) {
    console.error("[webhook]", err);
  }
});

// ── Health check ───────────────────────────────────────────
app.get("/", (_req, res) => res.send("ok"));

app.listen(Number(PORT), () => {
  console.log(`\n▸ listening on :${PORT}`);
  console.log(`  webhook: http://localhost:${PORT}/webhook\n`);
});
