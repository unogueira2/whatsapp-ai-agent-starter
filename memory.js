// ─────────────────────────────────────────────────────────────
// memory.js — per-number conversation history, in process
// ─────────────────────────────────────────────────────────────
// Deliberately not a database. See README → "Known limitations".
// ─────────────────────────────────────────────────────────────

const MAX_TURNS = 20; // 10 exchanges (user + assistant)
const conversations = new Map();

/**
 * @param {string} number  phone in international format, e.g. "15551234567"
 * @returns {{ role: "user"|"assistant", content: string }[]}
 */
export function getHistory(number) {
  if (!conversations.has(number)) conversations.set(number, []);
  return conversations.get(number);
}

/**
 * Append a turn, dropping the oldest once past MAX_TURNS.
 * @param {string} number
 * @param {"user"|"assistant"} role
 * @param {string} content
 */
export function addTurn(number, role, content) {
  const history = getHistory(number);
  history.push({ role, content });
  while (history.length > MAX_TURNS) history.shift();
}
