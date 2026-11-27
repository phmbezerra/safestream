# T-15 — Incident Reporting and Audit Trail

**Status:** Implemented - experimental lab MVP; not production-ready.

## Objective

Implement a privacy-minimizing reporting workflow
for synthetic SafeStream participants, with an
authorized moderation queue and auditable transitions.

References: FR-05, FR-06, NFR-01, NFR-03, NFR-07.

## Scope

- Authenticated room members can create reports.
- Reports receive unpredictable unique identifiers.
- Report submissions use predefined categories only.
- Moderation requires separately provisioned credentials.
- Reporters can inspect their own report status.
- Moderators can triage and resolve reports.
- Status transitions generate audit events.
- Reports remain available after an emergency room stop.

No free-text descriptions, media uploads, recordings,
screenshots, SDP, bearer tokens or invitations are stored.

## Implemented endpoints

POST /api/rooms/:roomId/reports
GET /api/reports/:reportId
GET /api/moderation/reports
POST /api/moderation/reports/:reportId/transitions
GET /api/moderation/reports/:reportId/audit

All endpoints require backend authorization.

## Report fields

- id: unpredictable identifier
- roomId: originating room identifier
- reporterId: derived from authenticated session
- category: predefined enum
- status: submitted, triaged or resolved
- createdAt: server-generated timestamp
- updatedAt: server-generated timestamp

Audit entries record report ID, action, actor ID,
server timestamp and previous/next status.

Client-provided actor IDs, status and timestamps
must not be trusted.

## Authorization model

- Anonymous users cannot submit or read reports.
- Outsiders cannot report on rooms they did not join.
- Reporters can access only their own reports.
- Room owners have no automatic access to reports.
- Moderators require server-provisioned authorization.
- A user choosing the label "Moderator" gains no privilege.
- Revoked members cannot submit new reports.
- Previously submitted reports remain independently accessible
  to their reporter after room termination.

## State and reliability

Report and audit storage must be independent of
the T-14 room cleanup behavior.

Do not acknowledge successful submission before the
required storage operation succeeds.

Persistence is optional and uses SAFESTREAM_REPORT_STATE_FILE.
When enabled, SAFESTREAM_STATE_FILE is required to recover
reporter identities. Writes precede success responses.
Records expire after seven days; Idempotency-Key is optional.

## Security tests

- Reject unauthenticated and unauthorized requests.
- Prevent forged moderator privileges.
- Prevent cross-report access and enumeration.
- Prevent client-controlled audit fields.
- Reject invalid categories and oversized payloads.
- Verify valid status transitions and their audit records.
- Verify report continuity after Emergency Stop.
- Verify persistence and failure handling.
- Verify that no raw media or credentials are stored.
- Global capacity is tested; per-user rate limits remain pending.

## Privacy and evaluation

Use synthetic identities and harmless scenarios only.

Define a bounded retention policy before accepting
persistent incident records.

Submission and triage latency measurements remain pending.

## Acceptance

T-15 passes only after automated authorization tests,
persistence and recovery tests, an incident drill,
and explicit reporting of limitations.

No production moderation or actual protective
intervention is claimed.
