# T-07B — Selective WebRTC revocation: evidence protocol

**Status:** instrumented lab protocol. No production claims. Media is real VP8/RTP over WebRTC, not screen snapshots over WebSocket.

## Research claim and falsification

**Hypothesis:** after removing Bob's room membership, the Pion media endpoint closes Bob's server-side WebRTC transport even when Bob ignores local shutdown instructions, while the authorized viewer Carol continues receiving and decoding video.

**Falsifying observations:** Bob's `bytesReceived`/`framesDecoded` keep increasing beyond a 2-second drain allowance, Carol's counters stop growing, the server audit does not show an authorization rejection and transport closure for the same endpoint, or either browser never received video before revocation.

## Setup

1. Run the existing SafeStream Node API and Vite frontend (`npm run dev`).
2. Start Go media relay from `sfu/`, capturing its terminal output to `reports/t07/pion.log` (see patch `INSTALL.md`).
3. Open three browser contexts at `http://localhost:5173/sfu-lab.html`: Alice, Bob, Carol. Create three synthetic sessions, one room, and separate one-use invites.
4. Bob enables **Ignore revocation notification locally** before connecting. Carol remains a normal viewer.
5. Alice starts sharing an innocuous moving window; Bob and Carol connect and both visibly decode frames for at least five seconds.
6. Alice revokes **Bob only**, without stopping her share.
7. Keep Bob and Carol open for 12–15 seconds. **Do not click Disconnect** during this observation window.
8. On Bob and Carol, click **Export evidence JSON**. Optionally export Alice too to corroborate the HTTP action.
9. Save the exports and server log locally. Run `analyze_t07.py` using the commands in `INSTALL.md`.

## Logged data and safeguards

Browser exports: `at`, `performanceMs`, peer connection state, WebRTC `inbound-rtp` bytes/packets/decoded frames (and publisher outbound bytes), synthetic label, synthetic room ID, plus explicit action/close events. The recorder is in-browser memory only, limited to the most recent 3,000 samples and 1,000 events. **Video frames, SDP, tokens, invites, cookies and content are not exported.** Review all files before publishing them anyway; browser user-agent and synthetic room IDs are included.

Go terminal: JSON audit lines prefixed `T07_EVENT` with UTC timestamp, room ID, non-secret server endpoint ID, role, authorization decision, and close reason/code. The media server does not log media payloads. Avoid logging more data than the lab requires.

## Analysis acceptance criteria

- Bob and Carol exported from the same room.
- Bob had nonzero decoded frames before the revoke-related `4003` socket closure and was in *non-cooperative* mode.
- Bob's decoded frames and inbound bytes do **not** grow between roughly `t0+2s` and `t0+10s`; this excludes an initial drain/buffering window.
- Carol's decoded frames **and** inbound bytes grow over roughly `t0` to `t0+10s`.
- Server audit includes correlated `authorization_rejected` and `transport_close_complete (4003)` events for the same media endpoint near Bob's close event.

A single preliminary pass is **not** a measured enforcement guarantee. Repeat at least three complete trials, inspect unexpected results, and later automate a continuous RTP benchmark under jitter, load and different network conditions. Media already delivered or recorded cannot be revoked.

## Caveats

- WebRTC `getStats()` counters are cumulative, asynchronous and not a capture of every packet at the kernel; this is evidence about receive/decode behavior, not a cryptographic guarantee.
- The Go authorization poll runs approximately every 100 ms, but API delays, scheduling and network behavior affect actual revocation time.
- A polling error currently fails closed: an authorization API outage may disconnect valid viewers, which is an availability trade-off.
- This experiment cannot be generalized to Discord's architecture or regulatory compliance.
