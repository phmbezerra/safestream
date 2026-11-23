# T-03 — Persistent media after membership revocation

**Status:** signaling enforcement implemented; actual media-access revocation **not proven**.

## Hypothesis

A server can revoke a viewer's room membership and signaling privileges, but this does not necessarily terminate an already-established peer-to-peer WebRTC media transport when a peer is modified or uncooperative.

## Change in v0.3

On owner-initiated membership revocation:

1. The server removes the member from the room and closes their WebSocket with code `4003`.
2. The server sends a `peer-revoked` event to connected remaining participants.
3. A cooperating publisher's browser closes its local `RTCPeerConnection` for that viewer and reports this in its in-memory event log.
4. Subsequent HTTP membership checks and WebSocket authentication for the revoked account are rejected.

**Warning:** a dishonest or modified publisher can ignore step 3. An already-connected viewer can also ignore a revocation notice. Server-side signaling policy is not server-side enforcement of existing P2P media delivery, and an acknowledgement is not proof of track shutdown.

## Automated checks

Run `npm test`. The added `server/test/revocation.test.js` checks the membership decision, WebSocket closure, peer notification, and rejection of reconnection. It does **not** simulate actual WebRTC media, latency, or compromised-client behavior.

## Manual cooperating-client check

1. Start `npm run dev` in the repository root.
2. Open Alice and Bob in separate browser contexts; establish a screen share.
3. Observe live video in Bob's **Remote** pane.
4. In Alice's **Members** section, click **Revoke viewer (best effort)**.
5. Observe that Bob's UI receives the revoke event and Alice removes the peer connection. Confirm the remote video clears.
6. Record whether the connection stopped, browser versions, any errors, and the observed timings. Do not claim a measured distribution from a single run.

## Adversarial study (future)

Create a controlled *modified publisher* test that deliberately ignores `peer-revoked`, then determine whether the viewer can continue to receive previously established media. Use generated/safe images and local test accounts only. This requires an instrumentation harness; the automated tests above do not perform it.

## Design choices for further research

- **Controlled publisher:** close peer connections, stop and replace sending tracks; effective only if the publisher cooperates.
- **SFU enforcement:** relay media through a policy-enforcing server capable of preventing future forwarding to revoked participants. Introduces hosting cost, latency, metadata visibility and threat boundaries.
- **Key-based epoch rotation:** investigate carefully designed group key rotation; difficult in P2P media systems and cannot prevent past recordings. Do not equate a rotated signaling token with media-key revocation.

## Evidence standard

Document the threat actor (honest / modified / compromised), which connection was actually closed, whether media bytes stopped, and how verified. Avoid implying production safety or regulatory compliance.
