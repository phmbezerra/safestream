# T-10A — Synthetic RTP load over real WebRTC transports (v0.11)

**Status:** Experimental benchmark harness. No performance result is claimed until the operator runs it and reviews its JSON output.

## Research question

How does the single-host Go/Pion media relay behave when 1, 2, 5, 10 and 20 synthetic viewers each negotiate a real WebRTC transport and receive RTP payloads from a single publisher?

## Scope and controls

- The driver is limited to loopback Node HTTP and Pion WebSocket URLs; it refuses non-loopback destinations and caps concurrent viewers at 20.
- The Node API runs without `SAFESTREAM_STATE_FILE` on a **separate port 3101**. The benchmark creates new synthetic sessions, one room per load level, and one-use invites. Do not run this against your normal persistent authorization store.
- The existing Go relay on port 3002 is started with `SAFESTREAM_NODE_API=http://127.0.0.1:3101`. No production Pion code is modified by T-10A.
- The publisher and all viewers use Pion PeerConnections and real DTLS-SRTP transport. The publisher sends synthetic, VP8-labelled RTP payloads. **These are deliberately not valid VP8-encoded video**, so browser decoding, visual quality and `framesDecoded` are not measured.
- Media packets and session secrets are not written to the report. The report is stored under ignored `reports/t10/`.

## Run (Windows PowerShell)

With old port 3002 server stopped:

**Terminal 1 — isolated Node authority**

```powershell
cd C:\Users\paulo\Downloads\safestream
Remove-Item Env:\SAFESTREAM_STATE_FILE -ErrorAction SilentlyContinue
$env:PORT = '3101'
npm run start -w server
```

**Terminal 2 — media relay**

```powershell
cd C:\Users\paulo\Downloads\safestream\sfu
$env:SAFESTREAM_NODE_API = 'http://127.0.0.1:3101'
go run .
```

**Terminal 3 — run the load driver**

```powershell
cd C:\Users\paulo\Downloads\safestream\sfu
go test ./bench/t10 -count=1
go run ./bench/t10 -levels 1,2,5,10,20 -seconds 6 -pps 30 -out ../reports/t10/t10a.json
```

Rerun twice or more for descriptive repeatability. To try a shorter smoke test:

```powershell
go run ./bench/t10 -levels 1,2 -seconds 3 -pps 15 -out ../reports/t10/smoke.json
```

## Recorded quantities

- `admittedAndConnected`: the number of viewers that passed API membership, received Pion's answer and reached WebRTC `connected` state.
- `viewersWithPackets`: viewers that actually received at least one RTP packet **during the measurement window**.
- `receivedPackets` and `receivedPayloadBytes`: observed synthetic RTP payload counters, not decoded frames or on-the-wire bytes.
- `p50ConnectionMs`, `p95ConnectionMs`, `p99ConnectionMs`: descriptive percentiles of **per-viewer sequential setup times**, using linear interpolation. They are not estimates of tail latency under simultaneous arrivals. At small n, p99 is particularly unstable.
- `packetReceptionRatePct`: approximate received packet ratio against the number of published packets and connected viewers. Can be slightly >100% due to asynchronous drainage; not a formal packet-loss measure.
- `publisherWriteErrors`: failures returned from publishing synthetic RTP packets.

The process returns nonzero if a requested viewer does not connect or fails to receive any media. This is a minimal smoke criterion, **not** a performance SLA or a threshold for acceptable packet loss.

## Proposed analysis

For each level report connected viewers / requested viewers, viewers with packets / connected viewers, throughput per viewer, time-to-connect distributions and any error. Repeat on a stable host; note Go version and Windows environment. Stop if the PC becomes unstable; do not extrapolate beyond the measured levels.

## Limits and next experiments

This benchmark measures the **media relay data path using synthetic RTP**, not browser video decoding, QoE, loss under network impairment, CPU/memory, or precise revocation cutoff. It performs a single run of each level with a single publisher, and setup is sequential. The relay polls the Node API per connected participant, which can itself become a bottleneck. The loopback host does not represent WAN conditions or production safety guarantees.

Planned follow-up: T-10B (revocation under load, server decision vs last observed packet); T-10C (CPU, memory, packet rate, resource-limited capacity). All runs remain local and use synthetic identities and payloads only.

## T-10A.2 — Five-run repeatability validation

**Result:** PASS (local experimental validation)

### Configuration

- Five independent benchmark runs
- Load levels: 1, 2, 5, 10 and 20 viewers
- Duration: 6 seconds per level
- Synthetic RTP rate: 30 packets/second
- Single local host and isolated Node authorization API
- Real Pion WebRTC connections; no decoded video

### Observed results

| Viewers | Successful connections | p95 range (ms) |
|---|---:|---:|
| 1 | 5/5 | 62.67–68.76 |
| 2 | 10/10 | 62.58–76.98 |
| 5 | 25/25 | 65.78–67.07 |
| 10 | 50/50 | 66.96–180.86 |
| 20 | 100/100 | 67.39–77.17 |

Across all five runs:

- 190/190 requested viewer connections succeeded.
- 190/190 viewer instances received synthetic RTP.
- The reported aggregate packet reception ratio was 100% at every level.
- All five benchmark runs completed successfully.
- No persistent increase in connection latency was established.
- Intermittent connection latency spikes were observed.

### Notable observations

- At 10 viewers, run 4 reported p95 = 180.86 ms
  and p99 = 250.15 ms.
- At 20 viewers, run 2 reported p99 = 228.88 ms.
- At 20 viewers, all five runs connected every requested
  viewer and reported RTP reception.

### Scientific limitations

- 190 represents cumulative viewer instances, not
  190 concurrent viewers.
- Maximum tested concurrency: 20 viewers.
- Single-host, loopback-only experiment.
- Connections established sequentially.
- RTP payloads were synthetic, not decodable VP8 video.
- Connection percentiles are descriptive estimates.
- Packet reception ratios do not prove zero network loss.
- CPU, memory, WAN behavior and revocation latency
  were not measured.
- No production scalability guarantee is claimed.

### Conclusion

The SafeStream relay successfully connected and delivered
synthetic RTP to every requested viewer across five local
runs at concurrency levels up to 20 viewers.

The experiment supports preliminary local repeatability,
but does not establish maximum relay capacity.
