# Threat Model

**Version:** 0.1 draft. This is a preliminary model for the *standalone research prototype*, not Discord's actual architecture.

## Assets

- A1: Confidentiality of stream audio/video/screen content.
- A2: Integrity of session membership, roles and permissions.
- A3: Ability to terminate a dangerous or unwanted stream promptly.
- A4: Confidentiality of identity, reporting and incident metadata.
- A5: Integrity and availability of reports and moderator actions.

## Actors and trust boundaries

Actors: publisher, viewer, room admin, moderator, platform backend, signaling service, potentially malicious participant, and external unauthenticated party.

Trust boundaries: browser ↔ signaling server; browser ↔ media transport; user ↔ authorization service; reporting UI ↔ moderation queue; application ↔ database. All client-supplied role, age label and incident fields are untrusted until validated. An age label in lab fixtures is **not** proof of age.

## Preliminary threat register

| ID | Scenario | Potential impact | Candidate control | Verification |
|---|---|---|---|---|
| T-01 | Unauthorized party joins a room or views a stream | Privacy breach | Server-side authorization and short-lived credentials | Negative membership tests |
| T-02 | Viewer exploits role changes or stale tokens to publish | Unauthorized broadcast | Authorization on every sensitive action; token expiration | Role-change tests |
| T-03 | Removed viewer retains stream access | Continuing exposure | Session/key revocation strategy and disconnect | Revocation-time measurement |
| T-04 | Malicious participant harasses or coerces another participant | Immediate safety risk | Block/report/leave/end-stream workflow; human escalation | Safe scripted incident drills |
| T-05 | Mass/spam reporting overwhelms responders | Delayed genuine reports | Queue deduplication, rate limits and human triage | Synthetic load tests |
| T-06 | Logs capture private media or identifying details | Privacy harm | Explicit data schema, minimization, retention/deletion policy | Data inventory and inspection |
| T-07 | Automatic risk flag wrongly blocks innocent users | Availability and fairness harm | Human review and appeal design | Synthetic false-positive testing |
| T-08 | Attackers bypass client-only safety controls | Control failure | Backend-enforced policies and defense in depth | Direct API authorization tests |

## Explicit non-goals / residual risks

- Preventing all coercion, grooming or harmful offline behavior.
- Reliable inference of real age from self-declared attributes.
- Assuming an automated classifier can reliably infer harmful intent.
- Preventing a viewer from externally recording their own screen.
- Treating end-to-end encryption as compatible with arbitrary server-side media inspection without additional architectural changes.

## Privacy and safety review gates

Before adding media analysis or age assurance, create a separate design decision record for data flows, accuracy, false positives/negatives, subgroup limitations, retention, security threats, and user remedies. No deployment with real users until ethics, security and consent reviews are complete.

## Open questions

- Where should policy checks happen for peer-to-peer versus SFU-based WebRTC?
- What happens to existing peer connections on permission revocation?
- Which incident metadata is strictly necessary and for how long?
- Which evidence can be generated without recording stream content?
