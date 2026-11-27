# T-14 — Emergency Stop: Room-Wide Termination

**Status: FUNCTIONAL VALIDATION PASSED — 2026-11-27.**

SafeStream T-14 introduces an owner-authorized emergency-stop
operation for an entire experimental communication room.

The experiment evaluated local media-capture termination,
server-side room invalidation, WebSocket closure, SFU access
enforcement, persistence failures, and safe startup recovery.

This is a research prototype, not a production-certified
emergency communication or safety system.

## 1. Research objective

Evaluate whether a room owner can initiate an emergency
termination that:

- Stops the cooperative publisher's local capture.
- Invalidates room-wide authorization on the Node API.
- Closes active Node signaling and legacy media connections.
- Causes the Go/Pion SFU to reject continued room access.
- Does not depend on viewers honoring client-side notifications.
- Avoids reporting successful persistence when storage fails.
- Prevents stale room grants from resuming after restart.

## 2. Experimental environment

| Component | Configuration |
|---|---|
| Publisher / owner | Alice |
| Viewers | Bob and Carol |
| Backend | Node.js |
| Media relay | Go / Pion WebRTC SFU |
| Browser media | Real WebRTC / VP8 |
| API | TCP 3101 |
| SFU signaling | TCP 3002 |
| Browser laboratory | TCP 5173 |
| Experiment page | `web/public/t14-lab.html` |
| Experimental date | 2026-11-27 |

The testing environment was a local development laboratory.
No real-user identities or confidential media are required.

## 3. Emergency-stop design

The owner calls:

`POST /api/rooms/:roomId/emergency-stop`

The Node API verifies that the authenticated requester owns
the specified room.

For an authorized request, the backend attempts to persist
the room's removal, invalidates its in-memory authorization,
clears its membership and invitations, and closes signaling
connections with WebSocket code 4004.

The legacy media gateway also closes room connections.

The Go/Pion SFU independently checks room authorization
through the Node API. Once authorization is invalidated,
the SFU terminates affected media connections.

The browser attempts to stop its own local capture tracks
before sending the HTTP termination request.

This distinction matters: local capture termination and
server-side room invalidation are different operations.

## 4. Nominal real-media experiment

The experiment involved one publisher (Alice) and two
viewers (Bob and Carol) receiving real VP8 video.

The viewers were configured to ignore revocation
notifications locally, allowing observation of enforcement
without relying solely on cooperative client behavior.

After Alice initiated Emergency Stop:

- Alice's browser reported local capture tracks stopped.
- Room access was invalidated by the backend.
- The SFU closed viewer connections when authorization failed.
- After the initial post-stop observation, viewer RTP-reception
  and decoded-frame counters remained stable during an
  observation interval exceeding 20 seconds.

The SFU used WebSocket close code 4003 for lost room
authorization. That code is not a dedicated, unambiguous
Emergency Stop reason.

The results support the conclusion that the tested SFU
stopped forwarding media following room invalidation.

They do not establish precise packet-level enforcement
latency, instantaneous network delivery cessation, or
security against every possible deployment failure.

## 5. Authorization and persistence tests

Automated tests verify that:

- Unauthenticated callers cannot stop a room.
- A viewer cannot stop a room owned by another user.
- An authenticated owner can stop the room.
- The stopped room and its invitations become unusable.
- Signaling and legacy media connections are closed.
- Successfully persisted room termination survives restart.

### Storage failure during Emergency Stop

A simulated storage failure produces HTTP 503 rather than
claiming that room termination was durably recorded.

The Node process still invalidates the room in memory and
closes associated signaling connections.

The HTTP 503 response communicates that persistence was
not confirmed, even though local authorization was blocked.

## 6. Recovery and fail-closed startup

T-14 changes the previous T-08C restoration policy.

With an opt-in state file, user identity fingerprints can
survive a Node restart, but previously active rooms cannot
automatically regain authorization.

At startup, the Node backend attempts to remove old room
grants from its persisted snapshot before serving requests.

If this cleanup write fails, startup fails rather than
restoring potentially obsolete room permissions.

The recovery policy prioritizes authorization safety
over room availability. Owners must create new rooms
after restarting the Node process.

This is an intentional behavioral change from the original
T-08C room-restoration experiment.

## 7. Node API unavailable experiment

A separate experiment interrupted the Node authorization
service while the browser laboratory remained open.

The SFU closed its existing connection with WebSocket
code 1013, reporting authorization service unavailability.

A later Emergency Stop action stopped the browser's local
capture tracks and correctly reported that server-side
termination could not be confirmed.

The browser recorded a failed HTTP request rather than
claiming a successful remote shutdown.

Important limitation: the original SFU connection had
already closed before the button was pressed. This test
therefore demonstrates local capture termination and
honest failure reporting, not button-triggered shutdown
of an independently active remote stream during outage.

## 8. Automated validation

Validation completed on 2026-11-27:

| Check | Result |
|---|---|
| Node.js tests | 24 passed, 0 failed |
| Go package tests | Passed |
| Go compilation | Passed |
| React/TypeScript/Vite build | Passed |
| JavaScript syntax validation | Passed |
| Git whitespace validation | Passed |

Key tests include HTTP persistence failure, WebSocket
termination, owner authorization, restart recovery, and
failure to persist recovery cleanup.

The Go tests exercise SFU disconnection behavior under
room authorization loss. Automated results complement,
rather than replace, the real-media experiment.

## 9. Remaining limitations

- This is an experimental single-process persistence model,
  not a transactional or replicated database.
- Power loss, filesystem corruption, and multi-instance
  deployment have not been comprehensively validated.
- SFU access enforcement depends on its authorization
  checking mechanism and connectivity to the Node API.
- A remote browser's operating-system capture process is
  not directly controlled by the room owner.
- HTTP/WS local development does not provide a
  production-ready secure network configuration.
- No independent cross-device clock synchronization was
  established for precise shutdown latency measurement.
- Browser-side failure reporting does not prove that all
  remote network components have completed shutdown.
- The tested design does not establish end-to-end media
  confidentiality against the SFU.

## 10. Conclusion

**T-14 functional objectives were achieved within the
tested laboratory scope.**

The system demonstrated owner-authorized room termination,
local capture shutdown, server-enforced removal of room
authorization, and fail-closed handling of selected storage
and authorization-service failures.

The results do not establish production readiness or
absolute guarantees of instantaneous media termination.

The next research phases should examine adversarial
failure scenarios, operational hardening, independent
latency measurements, and secure deployment architecture.
