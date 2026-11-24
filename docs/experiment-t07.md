# T-07 — Real WebRTC RTP forwarding and revocation (protocol)

**Status:** Implementation candidate / unverified integration. Do not publish findings before performing the experiment.

## Setup

- Node API and Vite frontend running (`npm run dev`).
- Go/Pion relay on `127.0.0.1:3002` (`cd sfu && go mod tidy && go run .`).
- Chrome/Chromium with VP8 codec available. All three browser contexts on `http://localhost:5173/sfu-lab.html`.
- Synthetic accounts Alice (publisher), Bob and Carol (viewers). Safe local window (moving animation) for screen share.

## Positive-control test

1. Alice creates a room, generates one-time invites for Bob and Carol.
2. Bob and Carol create their own demo sessions and join with *different* invites.
3. All three click **Connect SFU media**. Alice grants screen share.
4. Check that Bob and Carol receive changing video and `framesDecoded > 0`, `bytesReceived` grows.
5. Keep Carol connected while Alice revokes Bob using the member list.
6. Record Bob's WebSocket code, frames/bytes before and after 5/10 seconds. Bob may tick **Ignore revocation notification locally** to simulate non-cooperation; server should still close his own transport.
7. Confirm Carol's decoded frames and bytes continue growing.
8. Attempt to reconnect Bob with his revoked synthetic session and record the 4001 rejection.

## Evidence log

Record OS, Go, Node, browser versions, timestamps, room setup, before/after counters, ICE states, disconnection codes, counts of failures, and whether any video froze due to unrelated ICE/codec errors. Only use synthetic content.

## Decision gate

Do not declare T-07 complete until at least three successful manual trials plus automated server enforcement and timing tests are available. Document the limitation that a local code test does not generalize to the public internet.
