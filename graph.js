// Reviewed against Meta's WhatsApp text/read-receipt documentation.
// See docs/graph-api-migration.md before changing this default.
export const DEFAULT_GRAPH_VERSION = "v25.0";

// Read configuration at call time, after index.js has loaded .env.
// This module has no startup, credential, or network side effects.
export function buildWhatsAppMessagesUrl({
  GRAPH_VERSION = DEFAULT_GRAPH_VERSION,
  PHONE_NUMBER_ID,
} = process.env) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
}
