# whatsapp-ai-agent-starter

A production-shaped starting point for a WhatsApp customer-service agent: **WhatsApp Cloud API → Claude → WhatsApp**, in about 250 lines and one dependency. For small businesses that need an agent answering real customers, not a demo.

> ⚠️ **TODO before publishing:** add a 5–10s screen recording of a real conversation here.
> This is the first thing anyone looks at, and a README without it reads as untested.

---

## Why this exists

Most WhatsApp bot tutorials stop at "echo the message back." The distance between that and something you can point a paying customer at is entirely made of details that nobody writes down: the token that dies in 24 hours, the retry storm that double-replies, the tunnel URL that changes every restart.

This repo is those details, with the code around them.

---

## Architecture decisions

The parts worth arguing about.

**Ack the webhook first, then do the work.** Meta retries any webhook it doesn't get a fast `200` for. Calling Claude takes 1–3 seconds, which is long enough to trigger a retry — and the retry is a *fresh* delivery, so the customer gets the same answer twice. So `res.sendStatus(200)` fires before any processing. The tradeoff: a crash mid-processing loses that message silently, since Meta already considers it delivered.

**Signature verification is required in production, optional locally.** The webhook is a public URL that spends your Anthropic credits. Without `X-Hub-Signature-256` verification, anyone who finds it can drive the agent. `APP_SECRET` is optional so `npm start` works on the first try, but the server prints a warning at boot when it's missing — a silent insecure default is worse than a noisy one.

**Conversation memory is an in-process `Map`, not Redis.** A ring buffer of 20 messages per phone number. Restart the process and everyone starts over. That is genuinely fine for a single-instance shop bot, and it removes an entire piece of infrastructure — but it is the first thing to replace when you scale past one instance. Called out honestly under *Known limitations* rather than hidden.

**No `dotenv`.** ~20 lines of hand-rolled parsing instead. It keeps the dependency count at one, and real environment variables take precedence over the file, which is what you want on Railway/Fly/Render where there is no `.env` at all.

**Scope and handoff rules come before the knowledge base in the system prompt.** Not cosmetic. An agent that knows what it must *not* answer is worth more than one that knows more facts. With the knowledge base first, the model treats the boundaries as suggestions and starts improvising prices.

**Replies are split into at most 3 messages, with a length-proportional delay.** A single 900-character block that arrives 200ms after the question reads as a machine. Sentence-boundary splitting plus an 800ms–6s delay reads as a person typing. Cosmetic in the code, decisive in whether customers keep talking.

---

## Operational traps

The things that actually cost hours.

**The token in the Meta dashboard expires in 24 hours.** It is labeled "temporary" in small text and works perfectly until the next morning. For anything real, create a **System User** token (Business Settings → System Users → Generate Token) — that one does not expire.

**`WHATSAPP_TOKEN` must be on a single line in `.env`.** The token is ~200 characters. Pasting it into a `.env` through PowerShell can insert a line break, and the parser then reads a truncated token. The failure is a `401` with no indication that the value is malformed rather than wrong. Check with:

```bash
grep -c . .env
```

If the line count is higher than the number of variables you defined, something wrapped.

**Use Cloudflare Tunnel, not ngrok.** Free ngrok gives a new URL on every restart, and every new URL means re-entering the webhook in the Meta dashboard *and* redoing the verification handshake. A named Cloudflare tunnel keeps a stable hostname across restarts, so you configure the webhook once:

```bash
cloudflared tunnel --url http://localhost:3000
```

**`VERIFY_TOKEN` is invented by you.** It is not issued by Meta. It just has to match, byte for byte, what you type into the webhook config. A trailing space here produces a `403` that looks like a permissions problem.

---

## Running it

Node 18+ (needs built-in `fetch`).

```bash
npm install
cp .env.example .env
```

Fill in `.env`, then:

```bash
npm start
```

You should see `▸ listening on :3000`. In a second terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then in the Meta dashboard → WhatsApp → Configuration → Webhook:

- **Callback URL:** `https://<your-tunnel>.trycloudflare.com/webhook`
- **Verify token:** whatever you put in `VERIFY_TOKEN`
- Subscribe to the **`messages`** field

The server logs `[webhook] verified ✓` on a successful handshake. Message your test number and watch for `[in]` / `[out]`.

Syntax check without running:

```bash
npm run check
```

Credential-free tests (no Meta or Anthropic requests):

```bash
npm test
```

## WhatsApp Graph API version

The default is **`v25.0`**, also set in `.env.example`. `GRAPH_VERSION` in the
environment or `.env` overrides it; an existing `v21.0` pin must be removed or
updated explicitly. This setting affects outbound requests, not the webhook
subscription version configured in Meta's dashboard.

The [2026-10-07 compatibility review](docs/graph-api-migration.md) compares the
relevant changes from v21.0 and links the official v25.0 text/read-receipt
examples. Local tests verify URL construction, overrides and simulated webhook
requests through the actual server. They do **not** prove live Meta acceptance
or delivery; no live-account test was performed.

---

## Making it yours

Everything business-specific lives in [`prompt.js`](prompt.js). Replace the `{{PLACEHOLDERS}}` and write the knowledge base section in plain prose — you are writing for a language model, not filling a database schema.

`index.js` and `memory.js` typically don't change between deployments.

One rule for the knowledge base: **if you wouldn't be comfortable with the text being screenshotted and posted publicly, it does not belong in a system prompt.**

---

## Known limitations

Stated plainly, because a starter that hides its edges wastes your afternoon.

- **Memory dies with the process.** Single instance only. Two replicas means two disjoint memories for the same customer.
- **No idempotency on message ID.** Meta can legitimately deliver the same message twice; this replies twice. Fix by keeping a seen-ID set before processing.
- **Text only.** Images, audio, location, and interactive replies are ignored — not rejected, just silently skipped.
- **No per-number rate limit.** One person can spam the agent and run up your API bill.
- **`max_tokens: 500`.** Fine for customer service. Raise it and reconsider `splitMessage`.
- **Errors are logged, not surfaced.** If Claude or the WhatsApp API fails, the customer gets silence. Production needs a fallback message.

---

## License

MIT — see [LICENSE](LICENSE).
