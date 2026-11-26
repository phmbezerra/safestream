# T-10B — Selective media revocation under viewer load

**Status:** Functional criteria PASS in three local runs; HTTP latency measurement under investigation.

## Hypothesis

With a single publisher and 2–20 authorized WebRTC viewers, revoking one viewer in the Node authorization API should cause the Pion relay to close that viewer's media WebSocket with code `4003`, deny a new admission with code `4001`, and preserve ongoing RTP delivery to all remaining authorized viewers.

## Design

The benchmark (`sfu/bench/t10b`) establishes genuine Pion WebRTC publisher and viewer connections to the existing local relay, using only synthetic VP8-labelled RTP payloads. It creates fresh demo sessions and a new room for each round; no real accounts, images, recordings, or credentials are saved to the report.

1. Connect one publisher and N viewers **sequentially**.
2. Confirm every viewer has received at least one RTP packet.
3. Revoke viewer 1 (Bob) using the actual `DELETE /api/rooms/:roomId/members/:userId` endpoint. Record request-to-HTTP-response duration.
4. Observe Bob's media WebSocket closure and its code, recording the time from revocation request start. This is a **client-observed signaling/transport event**, not proof that the last RTP packet was already delivered.
5. Wait 350 ms for in-flight packets to settle, then observe a 1–5-second quiet window while RTP sending continues. Verify Bob receives zero new RTP packets **in the observed quiet window**, and every other viewer receives additional packets while staying connected.
6. Verify Bob's attempt to reconnect to the media WebSocket is denied with `4001` and Node membership lookup returns HTTP `403`.

## Operational protocol — local Windows PowerShell

Keep the **Node API on 3101** and **Pion media relay on 3002** running (same setup as T-10A). Node must be launched without `SAFESTREAM_STATE_FILE`; the isolated API is intended to keep the benchmark separate from the persistence experiment. No Vite frontend is needed.

Run from the repository's `sfu` folder:

```powershell
go test -count=1 ./...

go run ./bench/t10b `
  -viewers 2 `
  -rounds 1 `
  -quiet-seconds 2 `
  -pps 30 `
  -out ../reports/t10/t10b-smoke.json

go run ./bench/t10b `
  -viewers 20 `
  -rounds 3 `
  -quiet-seconds 2 `
  -pps 30 `
  -out ../reports/t10/t10b-20.json
```

Do **not** proceed to 20 until the two-viewer smoke test passes. Each trial is marked `passed` only when both revocation checks and every positive control succeed. On a failure, the command stops and writes diagnostic JSON; preserve logs and investigate.

## Fields and interpretation

- `apiRevocationResponseMs`: request start → HTTP 200 response. It measures the API round trip, **not** when Pion first stopped forwarding.
- `mediaWebSocketCloseMs`: request start → `4003` observed by the revoked client's Go WebSocket reader. Includes policy polling and scheduling.
- `lastObservedRtpMsFromRequest`: time of last RTP read relative to request start; can be negative. **Not an upper bound on all possible future deliveries**.
- `targetPacketsBetweenHttpResponseAndQuietStart`: observed packets after HTTP response but before quiet-window start (including settling time). May be nonzero due to in-flight media.
- `targetPacketsDuringQuietWindow`: must be zero for the sampled local validation to pass.
- `otherViewersReceivingDuringQuietWindow`: must equal `N-1`.
- `otherViewersConnectedAtEnd`: must equal `N-1`.
- `readmissionDenied4001`, `membershipDenied403`: independent, explicit authorization controls.

## Limitations

Single-host loopback experiment, synthetic un-decodable RTP, serial admissions, small sample sizes, timer/scheduling noise and an explicitly chosen quiet window. The test does **not** prove an instantaneous cutoff at the authorization change, zero delivered buffered media, WAN scalability, production security, cryptographic media revocation, or a guaranteed time-bound SLA. The local Go client cannot directly measure when a browser stops rendering frames. No process resource profile or packet capture is performed.

**Evidence to collect:** successful/failed commands, per-round result fields, time distributions and Git diff. Never commit the JSON reports containing raw operational data even though they intentionally exclude tokens; `reports/t10/` is gitignored.

## T-10B — Observed experimental results

**Result:** PASS (functional criteria; three local runs)

### Configuration

- 20 viewers per round, including one revoked viewer
- 3 independent rounds
- 30 synthetic RTP packets per second
- 2-second post-close quiet observation window
- Single-host loopback WebRTC experiment

### Results

| Metric | Round 1 | Round 2 | Round 3 |
|---|---:|---:|---:|
| Connected viewers | 20/20 | 20/20 | 20/20 |
| WebSocket close code | 4003 | 4003 | 4003 |
| WebSocket close from request (ms) | 36.1735 | 78.0117 | 55.4452 |
| Last observed RTP from request (ms) | 16.1718 | 49.8644 | 49.9751 |
| Packets between HTTP response and quiet window | 1 | 2 | 2 |
| Packets during quiet window | 0 | 0 | 0 |
| Remaining viewers receiving RTP | 19/19 | 19/19 | 19/19 |
| Readmission denied (4001) | PASS | PASS | PASS |
| Membership denied (HTTP 403) | PASS | PASS | PASS |
| Publisher write errors | 0 | 0 | 0 |

### Additional validation

- Two-viewer smoke test: PASS.
- Go tests: all packages PASS.
- Go race detector: all executed tests PASS.

### Measurement caveats

- HTTP revocation duration values were 0, 0 and 0.022 ms.
  These values require independent verification and must
  not be presented as established API latency.
- Some RTP was observed after the HTTP response and before
  the post-close quiet observation window.
- The quiet window began 350 ms after WebSocket closure.
- No RTP was observed during the sampled quiet windows.
- Last observed RTP timestamps are not guaranteed delivery cutoffs.
- Results are limited to synthetic RTP and local loopback.
- No production security or latency guarantee is claimed.

### Conclusion

In three local trials with 20 connected viewers, revoking
one viewer closed its media WebSocket with code 4003,
prevented readmission, and left the other 19 viewers
connected and receiving RTP.

The functional criteria passed. Precise HTTP revocation
latency and end-to-end media cutoff remain unverified.
