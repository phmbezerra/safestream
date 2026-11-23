# ADR-001: Peer-to-peer WebRTC in the first lab

**Status:** Experimental, non-production.

## Decision

Use a local HTTP service and WebSocket signaling with direct WebRTC peer connections. The server enforces role permissions on **signaling actions** (join, invite, offer, revoke). Media is exchanged between browsers and is not processed or stored by the server.

## Important limitation

**Signaling authorization is NOT media authorization.** Once a P2P connection is established, a peer may retain media access even after its application session is revoked. A malicious client can ignore revocation messages. This MVP therefore **does not satisfy FR-03's media-revocation requirement** and must not be used for sensitive content or real users. Session tokens are in memory and demo identities are self-declared.

## Follow-up architectural work

Evaluate an SFU/media relay with server-controlled subscriptions and enforceable transport revocation; add transport authentication, room capacity limits, auditability, and failure analysis. Even then, media already received may have been recorded externally and cannot be clawed back.

## Constraints

Localhost only; no TURN server; peers may fail to connect across NAT; test only with synthetic participants and benign screens. Development access to the browser's display capture APIs requires user permission. No third-party Discord interoperability.
