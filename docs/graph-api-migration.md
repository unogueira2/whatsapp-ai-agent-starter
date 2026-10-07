# WhatsApp Graph API review — 2026-10-07

## Decision and evidence

Migrate the default from **v21.0 to v25.0** for this starter's individual text
replies and incoming-message read receipts. Keep `GRAPH_VERSION` as an override.
Meta's [Graph changelog][graph] lists v21.0 through **2027-01-21**, v25.0 through
**2028-07-29**, and v26.0 released **2026-07-29**, with its sunset still TBD.
v21.0 was therefore still supported on the review date.

The choice is based on WhatsApp-specific evidence: Meta's [text-message guide][text]
and [read-receipt guide][read] both explicitly use **v25.0** examples with the
`/{version}/{phone-number-id}/messages` endpoint. The [Messages API reference][messages]
documents `POST`, Bearer authentication and JSON. This is evidence for the two
operations used here, not a claim that every Graph version or WhatsApp feature
is interchangeable. v26.0's release alone is not our compatibility evidence;
v25.0 is the newer supported target explicitly demonstrated by both guides.

## Comparison with the v21.0 implementation

| Change reviewed | Impact on this repository |
| --- | --- |
| [v22.0][v22]: Instagram/Page/Marketing changes; no WhatsApp messages change listed on that version page. | Those APIs are not called. This absence alone was not used as proof of WhatsApp compatibility. |
| [v23.0][v23] and [WhatsApp changelog][whatsapp], 2025-05-29: error `132018` for invalid template parameters; Embedded Signup v3 changes. | The bot sends plain text, does not create/send templates and has no Embedded Signup implementation. |
| [v24.0][v24] and WhatsApp changelog, 2025-10-08: portfolio-based messaging limits; `whatsapp_business_manager_messaging_limit`; changed `messaging_limit_tier`; template pagination error `131059`. | No limit-query or template-list endpoint is called. Runtime account limits still apply. |
| v24.0+: status webhooks generally omit `conversation`, except messages sent within a Free Entry Point window. | The handler ignores payloads without `value.messages` and never reads `statuses[].conversation`. A simulated status without `conversation` is covered by the tests. |
| [v25.0][v25]: `metadata=1` deprecated; Insights changes; Webhooks mTLS CA transition effective 2026-03-31. | No metadata/Insights requests exist. This Express app checks an HMAC signature when configured; it does not configure mTLS. Any deployment proxy requiring client certificates needs its own CA review; that infrastructure was not inspected. |
| [v26.0][v26], considered but not selected: legacy Graph query/protocol behavior removed. | This code uses none of `pretty`, `debug`, `date_format`, root `ids` queries or ETag caching. That observation does not substitute for WhatsApp-specific version evidence. |
| WhatsApp changes outside version releases: typing indicators (2025-04-08); per-message pricing (2025-07-01); omitted ad click ID for WhatsApp Status ad referrals (2025-10-20); extra unsupported-message details and `played` status (2025-11-03). | No typing indicator is requested; no pricing, referral or delivery-status fields are consumed. Billing changes are not avoided by pinning an older Graph version. No pricing or account-eligibility validation was performed. |

The WhatsApp changelog response retrieved during this review ended at 2026-05-12.
It is not presented as an exhaustive record of subsequent 2026 changes. The
version selection also relies on the directly retrieved operation references
and Graph availability table, not solely on that changelog response.

## Contract retained and adjustment made

- **Send text:** same `POST /{version}/{phone-number-id}/messages`, Bearer header,
  `messaging_product`, `to`, `type: "text"`, and `text.body`.
  Explicitly send `recipient_type: "individual"` to match the current reference
  and v25.0 guide. The old code omitted it; this review does not assert that its
  omission is newly rejected in v25.0.
- **Mark read:** same endpoint and method; same `messaging_product`,
  `status: "read"`, and `message_id`. No typing indicator is required.
- **Receive text:** Meta's [text webhook reference][webhook] still documents
  `entry[].changes[].value.messages[]` with `id`, `from`, `type` and `text.body`,
  matching the fields the handler reads. Existing single-message-only processing
  is unchanged.
- `GRAPH_VERSION` controls the outbound URL. It does **not** change the app's
  webhook subscription version in Meta's dashboard.

## Reproduce the local validation

```bash
npm install
npm test
npm run check
git diff --check
```

Validated on Node **24.19.0**: **8 passing tests**, syntax checks and clean
whitespace checks. No test-runner dependency was added. The URL tests can also
run without installing Express: `node --test test/graph.test.js`.

The tests assert the exact default URL, alternate version and phone number ID,
environment lookup after module import, and alignment of `.env.example`.
Integration tests start the actual `index.js` in a temporary directory, use only
fake credentials, send loopback webhook requests and stub **all external fetch
calls**. They verify both outbound URLs, POST methods, Bearer/JSON headers and
request bodies for the default, a `.env` override, and an environment variable
overriding `.env`. They also check that status callbacks without `conversation`
produce no outbound calls.

**Limits:** These tests establish local configuration and request construction,
not live Meta acceptance, message delivery, token permissions, webhook signatures,
account eligibility, billing or reverse-proxy configuration. No WhatsApp message
was sent and no Meta/Anthropic credentials were used. Documentation review is
the compatibility basis; the stubs are not a Meta conformance test.

## Deployment follow-up

Existing `.env` files and hosting environment variables are not rewritten.
Remove an existing `GRAPH_VERSION=v21.0` pin to use the default, or explicitly set
`GRAPH_VERSION=v25.0`, then restart. A nonempty hosting variable continues to take
precedence over the `.env` file. The existing behavior for an explicitly empty
value is unchanged; omit the variable to select the default.

Before production rollout, use an authorized test number to receive a text,
confirm the read receipt and delivered reply, and check the app's separate
webhook version and any mTLS configuration. This live check remains unperformed.
For temporary rollback, set `GRAPH_VERSION=v21.0` and restart only while that
version remains available (through 2027-01-21 per the reviewed table); the new
default does not remove the override.

[graph]: https://developers.facebook.com/docs/graph-api/changelog/
[v22]: https://developers.facebook.com/docs/graph-api/changelog/version22.0/
[v23]: https://developers.facebook.com/docs/graph-api/changelog/version23.0/
[v24]: https://developers.facebook.com/docs/graph-api/changelog/version24.0/
[v25]: https://developers.facebook.com/docs/graph-api/changelog/version25.0/
[v26]: https://developers.facebook.com/docs/graph-api/changelog/version26.0/
[whatsapp]: https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog
[messages]: https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api
[text]: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages
[read]: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/mark-message-as-read
[webhook]: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text
