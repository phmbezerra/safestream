# T-10C â€” Windows resource sampling under synthetic RTP load

**Status:** Local functional and resource measurements completed; exploratory PASS.

## Hypothesis and scope

Measure **Pion** (port 3002) and **Node authorization service** (port 3101) CPU time and process memory while RTP is actively sent with 1, 2, 5, 10 and 20 viewers.

The `tools/t10c/measure.ps1` runner starts one existing T-10A load benchmark per level, and samples the Windows process IDs that **own the listening ports**, not `go.exe`, which only launches the benchmark.

T-10A now optionally writes `-phase-file <path>` markers: `active` after negotiation/warmup and `complete` after the timed RTP interval. Without that flag, T-10A retains its previous behavior. T-10C samples only while phase is `active`; setup/compilation are excluded. Markers are lab instrumentation, not production signaling.

## Commands (PowerShell 5.1, Windows)

First start the isolated Node API on 3101 and Pion on 3002 as in T-10A. No frontend is needed. With both services alive:

```powershell
cd C:\Users\paulo\Downloads\safestream
Invoke-RestMethod http://127.0.0.1:3101/api/health
Invoke-RestMethod http://127.0.0.1:3002/health
cd sfu
go test -count=1 ./...
cd ..
.\tools\t10c\measure.ps1 -Levels 1,2 -Seconds 6
```

Then full load:

```powershell
.\tools\t10c\measure.ps1 -Levels 1,2,5,10,20 -Seconds 8 -SampleMs 250
```

If local execution policy blocks `.ps1` scripts, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\t10c\measure.ps1 -Levels 1,2 -Seconds 6` for the one-time invocation. Do not change machine-wide execution policy.

Reports under ignored `reports/t10/t10c/`:

- `t10c-summary.json`: one record per level, measured CPU and memory, payload throughput
- `samples-level-N.csv`: raw samples for transparency
- `t10a-level-N.json`: original T-10A per-viewer RTP metrics
- `level-N.stdout.txt`, `level-N.stderr.txt`, `phase-N.txt`: local diagnostic artifacts

## Definitions and limitations

- **averageCoreEquivalentCpuPercent:** delta process CPU seconds divided by sample wall-time seconds Ã— 100. 100% corresponds to one logical CPU core; aggregate process usage on multicore may exceed 100%. It is not percent of total-machine capacity.
- **peakWorkingSetMB:** peak resident working set among active samples.
- **peakPrivateMemoryMB:** peak private memory among active samples; distinct from RSS and Go heap.
- **aggregateReceivedPayloadMbps:** `8 * totalPayloadBytesReceived / durationSeconds / 1e6` as reported by T-10A; only synthetic RTP payload, not actual network NIC bandwidth.
- This is a *single-host exploratory benchmark* with serial connection setup, 250ms default sampling, Windows scheduler noise and synthetic media. Report repeated trials separately before trend or capacity claims.
- Underlying T-10A currently caps 20 viewers. No claim for larger loads or real decoded VP8 video.
- Process sampling has overhead; compare like-for-like and retain full raw observations. One run should not be reported as statistical proof.
- The Node API retains synthetic session/room metadata in memory during one process lifetime; memory across ordered levels can reflect accumulation from prior levels, not just active viewers. Restart clean lab services and repeat levels in reverse order before attributing differences to concurrency.

## Evidence checklist

Record both `/health` responses, `go test -count=1 ./...`, resource summary, and whether any viewers failed. Do not include tokens or SDP in reports. Keep JSON and CSV reports out of Git using existing `reports/t10/` ignore entry. **Do not commit a PASS conclusion before a real Windows measurement.**

## T-10C.2 - Three-run resource validation

**Result:** PASS (local functional and resource measurement)

### Configuration

- Three repeated runs
- Load levels: 1, 2, 5, 10 and 20 viewers
- Eight seconds per level
- 30 synthetic RTP packets per second
- 900-byte synthetic RTP payload
- 250 ms resource sampling interval
- Windows local loopback environment
- Same Node and Pion processes across runs

### Observed results

All 114 requested viewer connections succeeded across the
three repetitions, and every viewer received synthetic RTP.

At 20 concurrent viewers:

| Metric | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| Pion CPU (core-equivalent %) | 4.16 | 4.58 | 4.47 |
| Pion peak Working Set (MB) | 51.63 | 50.65 | 50.78 |
| Node CPU (core-equivalent %) | 2.08 | 0.60 | 0.85 |
| Aggregate RTP payload (Mbps) | 4.325 | 4.337 | 4.338 |

### Findings

- All 20 viewers remained connected and received RTP
  at the maximum tested load in every repetition.
- Pion CPU at 20 viewers ranged from 4.16% to 4.58%
  of one logical CPU core.
- The initial standalone measurement of 9.06% CPU
  was not reproduced in the three subsequent runs.
- Pion peak Working Set at 20 viewers ranged from
  50.65 MB to 51.63 MB.
- Aggregate received payload increased approximately
  proportionally to the number of viewers.
- Some lower-concurrency runs recorded unexpectedly
  high memory peaks, requiring additional investigation.

### Limitations

- Three repeated measurements are exploratory, not
  sufficient to establish production capacity.
- The same server processes remained active across runs.
- Node accumulated synthetic session and room metadata.
- Windows scheduling and sample resolution introduce noise.
- CPU values near zero do not imply zero computation.
- Working Set measurements are not Go heap measurements.
- Payload Mbps excludes transport and network overhead.
- The test used synthetic RTP, not decodable video.
- No maximum capacity or production SLA is established.

### Conclusion

SafeStream successfully maintained RTP delivery for up to
20 concurrent synthetic WebRTC viewers in three repeated
local resource tests.

Measured CPU and memory remained within the observed ranges,
but additional controlled tests are necessary to determine
resource scaling and maximum capacity.
