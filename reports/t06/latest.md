# T-06 — Automated Media Revocation Benchmark

**Run started:** 2026-11-23T20:24:14.931Z  
**Environment:** v24.18.0 on win32/x64  
**Run count:** 20  
**Passed:** 20  
**Failed:** 0

## Observed metrics (client-side, local loopback)

| Metric | Min (ms) | Mean (ms) | p50 (ms) | p95 (ms) | Max (ms) |
|---|---:|---:|---:|---:|---:|
| Request → HTTP success | 15.928 | 16.57 | 16.492 | 17.27 | 17.364 |
| Request → media WebSocket close | 16.476 | 17.247 | 17.011 | 18.583 | 18.974 |

The latency measurements share a **monotonic clock in the benchmark process** and include local HTTP/WebSocket scheduling and transport overhead. They are **not** a server-internal media cutoff latency or end-to-end visual frame-decoding latency. Negative response-to-close values are possible because event ordering is asynchronous.

## Controls and criteria

- Bob receives a frame before revocation; Bob's client never voluntarily closes on the revocation notice.
- After server acknowledgment, Bob receives no newly observed frame messages.
- Bob's media socket closes with code 4003; a reconnect attempt is rejected with code 4001.
- Carol, who was not revoked, receives a fresh frame **after** Bob is revoked (positive control).

## Limitations

- This tests a **local JPEG-over-WebSocket gateway**, not WebRTC, an SFU, Discord, or real-world child safety.
- Synthetic test frames only; there is no decoding or persistence of media in the benchmark.
- The results do not bound in-flight/previously buffered media, and cannot prevent external recording.
- Local loopback performance is not representative of WAN latency or load.
- Report all failures and rerun with different loads rather than treating zero failures in 20 runs as absolute safety.

## Per-run outcomes

| Run | Result | Request→close (ms) | Frames after response | Carol received | Close codes (Bob / retry) |
|---|---|---:|---:|---|---|
| 1 | pass | 18.974 | 0 | true | 4003 / 4001 |
| 2 | pass | 17.179 | 0 | true | 4003 / 4001 |
| 3 | pass | 17.865 | 0 | true | 4003 / 4001 |
| 4 | pass | 17.299 | 0 | true | 4003 / 4001 |
| 5 | pass | 16.95 | 0 | true | 4003 / 4001 |
| 6 | pass | 17.262 | 0 | true | 4003 / 4001 |
| 7 | pass | 17.011 | 0 | true | 4003 / 4001 |
| 8 | pass | 16.946 | 0 | true | 4003 / 4001 |
| 9 | pass | 16.838 | 0 | true | 4003 / 4001 |
| 10 | pass | 17.793 | 0 | true | 4003 / 4001 |
| 11 | pass | 17.207 | 0 | true | 4003 / 4001 |
| 12 | pass | 16.89 | 0 | true | 4003 / 4001 |
| 13 | pass | 16.726 | 0 | true | 4003 / 4001 |
| 14 | pass | 18.583 | 0 | true | 4003 / 4001 |
| 15 | pass | 16.974 | 0 | true | 4003 / 4001 |
| 16 | pass | 16.476 | 0 | true | 4003 / 4001 |
| 17 | pass | 17.433 | 0 | true | 4003 / 4001 |
| 18 | pass | 16.795 | 0 | true | 4003 / 4001 |
| 19 | pass | 17.151 | 0 | true | 4003 / 4001 |
| 20 | pass | 16.597 | 0 | true | 4003 / 4001 |
