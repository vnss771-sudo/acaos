# Outbound send authorization matrix

ACAOS separates acquisition email from transactional/system mail. Acquisition mail must pass through `authorizeOutboundSend()` before the low-level mail provider is invoked.

| Path | Context | Shared authorization | Provider dispatch | Notes |
| --- | --- | --- | --- | --- |
| Campaign batch | `campaign` | Yes, batch scope + existing bulk per-recipient safety filters | Worker → `sendMail` | Workspace/platform/reputation fail closed before processing; recipient suppression/consent remain bulk-loaded for throughput. |
| Scheduled follow-up | `followup` | Yes, immediately before claim/dispatch | Worker → `sendMail` | Re-evaluates workspace suppression, reputation, recipient contact policy and consent at execution time. |
| Human inbox reply | `reply` | Yes, immediately before claim/dispatch | API → `sendMail` | Uses reply-specific recipient policy so an inbound reply is not blocked by cold-contact `ALREADY_REPLIED`; hard suppression still applies. |
| Auth emails | transactional | Not acquisition policy | API → `sendMail` | Reviewed transactional exception. |
| Billing notification | transactional | Not acquisition policy | API → `sendMail` | Reviewed transactional exception. |
| Workspace invite | transactional | Not acquisition policy | API → `sendMail` | Reviewed transactional exception. |
| Mailbox test send | operator test | Not acquisition policy | API → `sendMail` | Explicit settings/test action. |

## Audit evidence

Every call to `authorizeOutboundSend()` writes a best-effort append-only `AuditEvent` with:

- allow/deny outcome
- context
- stable reason code
- policy version
- related entity type/id
- actor user id when available
- observe-mode reputation findings when present

The audit metadata deliberately excludes message body, subject and recipient address.

## CI drift protection

`npm run check:send-authorization` fails when:

- an acquisition path loses its shared authorization call;
- authorization stops recording audit evidence;
- a new direct low-level mail-service call appears without explicit review;
- an existing direct-mail call count changes unexpectedly; or
- API/worker code bypasses `services/mail.ts` and calls Nodemailer/Graph provider dispatch directly.
