# T-06 — Automated media revocation benchmark

**Status:** automated experimental protocol; only local JPEG-over-WebSocket gateway. **Not** a WebRTC SFU, a child-safety system, or proof of regulatory compliance.

## Research question

Can the SafeStream v0.5 media gateway stop forwarding *new* synthetic frames to a revoked receiver while continuing to forward new frames to an unaffected authorized receiver?

## Experiment

Each independent trial creates Alice (publisher), Bob (revoked viewer) and Carol (unrevoked control viewer), with new test accounts, room and one-time invitations. The benchmark uses real local HTTP and WebSocket connections, not mocked authorization functions.

1. Authenticate all clients to `/media` in a new test room.
2. Alice sends a synthetic JPEG frame. Verify both Bob and Carol receive the frame with matching sequence numbers.
3. Wait until the gateway frame throttle window has passed (180 ms).
4. Initiate the membership-revocation HTTP request for Bob. Record client monotonic time for request start and successful response.
5. Bob's test WebSocket **does not voluntarily close on a revocation event**. Verify the gateway closes it with code **4003**; measure client-observed interval between request start and socket close.
6. Alice sends another synthetic frame. Verify Carol receives the new frame (control); verify no Bob frame is observed after the successful revocation response.
7. Attempt to reauthenticate Bob using his revoked account; verify gateway closes the connection with code **4001**.
8. Repeat using fresh room and accounts (default: **20 trials**). Record every pass and failure, including exceptions/timeouts.

## Running

From the repository root after applying v0.5 and v0.6 and installing the npm dependencies:

```powershell
npm test
node server/benchmarks/revocation.mjs --runs 20
```

The CLI writes `reports/t06/latest.json`, `reports/t06/latest.csv` and `reports/t06/latest.md`. They contain synthetic experiment metadata, not video or account secrets. Review the output before committing it. **Each run overwrites the `latest.*` files.**

## Measurement definitions

- `revokeRequestToHttpResponseMs`: timestamp immediately before HTTP request to timestamp of its successful response, recorded with `performance.now()` on the benchmark process.
- `revokeRequestToSocketCloseMs`: timestamp immediately before HTTP request to the revoked viewer's observed WebSocket close event, recorded using the same monotonic clock.
- `httpResponseToSocketCloseMs`: difference between observed close event and HTTP response; may be negative because the transport can close before the response is processed.
- `framesObservedAfterHttpResponse`: number of received `frame` WebSocket messages whose client-side timestamp is later than the successful revocation HTTP response.
- `controlViewerReceivedAfterRevoke`: whether unaffected Carol receives a fresh higher-sequence frame after the revocation.
- `revokedReconnectCloseCode`: gateway code when the revoked Bob tries to reconnect.

Summary reports include min, mean, p50 and p95 (nearest-rank on passing trials only), maximum, and pass/fail totals. Failures are included in the raw JSON/CSV and total counts; latency statistics on successful runs are **survivorship-biased** and must never be presented without failure counts.

## Limitations and possible confounders

- Measures gateway WebSocket delivery and closing, **not** decoded browser video frames or WebRTC media delivery.
- Intervals include client event-loop and local loopback scheduling; they do not isolate server-internal enforcement time, physical latency or decoding delay.
- Frames already buffered, delivered or captured by clients cannot be erased. Absence of post-response WebSocket frames is narrower than absolute prevention of later visual playback.
- Test frame size and 1×1 synthetic JPEG do not represent live video workloads.
- Measurements from one machine and small samples cannot establish production latency or reliability.
- 20/20 passing is not a proof of universal safety; investigate failures and repeat under additional simulated latency/load.
- P2P v0.4 and gateway v0.5 are architecturally different, not directly comparable for bandwidth/performance; they are compared only for **what component enforces forwarding decisions**.

## Research next steps

Add server-side instrumentation for precise authorization-decision-to-last-send timing, simulated latency/loss, real frame-decoding measurements, privacy impact analysis and a separate WebRTC SFU proof of concept if warranted.
