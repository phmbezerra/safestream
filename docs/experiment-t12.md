# SafeStream T-12 — real VP8 fan-out, validated local experiment

**Result: PASS — one local progressive trial with 2, 5, 10, and 20 simultaneous viewers (2026-11-26, UTC).**
This is an exploratory browser-co-located test, **not** a production capacity or independent-device scaling claim.

## Method and evidence
- Publisher: one browser `getDisplayMedia` screen capture encoded to WebRTC VP8, 1320×590 pixels, nominal 30 fps.
- Media path: browser publisher → Go/Pion relay (local loopback) → independent WebRTC PeerConnections for each viewer; all video elements and the publisher run in one Opera/Chromium browser on the same Windows machine.
- Each viewer uses its own session, invite, and WebRTC PeerConnection; levels ramp progressively without resetting the session.
- Each stage lasted 20 s; the analyzer excludes 1 s at each edge and measured about 17 s between the first and last valid stats samples, 18 samples per participant.
- Analyzer: `tools/t12/analyze.py`; status **OVERALL RESULT: PASS**, exit code 0, with per-viewer decoded and playback frame counters, connection state, codec, visibility, RTP loss and freeze deltas.
- Raw data: `t12-2026-11-26T16-59-27-439Z.json` (keep out of Git). Analyzer output: `analysis-t12-twenty-viewers.txt`.

## Stage-level results
| Viewers | Alice encoded FPS | Per-viewer decoded FPS range | Per-viewer playback FPS range | Aggregate incoming media Mbps* | Stage |
|---:|---:|---:|---:|---:|---|
| 2 | 29.87 | 29.81–29.81 | 29.81–29.81 | 5.01 | PASS |
| 5 | 29.88 | 29.94–29.94 | 29.94–29.94 | 12.49 | PASS |
| 10 | 29.88 | 29.88–29.88 | 29.88–29.88 | 24.92 | PASS |
| 20 | 29.71 | 29.65–29.71 | 29.65–29.71 | 50.41 | PASS |

*Mbps is calculated from cumulative WebRTC `bytesReceived` across local viewer PeerConnections divided by sampled elapsed time. It is not a NIC, internet throughput, or SFU process CPU measurement.

All four phases showed: 100% WebRTC `connected` in valid samples, browser tab `visible` in 100%, VP8 reported for all viewers, positive ready/playback counters, **zero newly reported packets lost**, and **zero newly reported freezes** during the sampled phase window.

## Twenty-viewer details
| Viewer | Decoded FPS | Playback FPS | Received Mbps* | New RTP loss | New freezes |
|---|---:|---:|---:|---:|---:|
| V01 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V02 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V03 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V04 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V05 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V06 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V07 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V08 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V09 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V10 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V11 | 29.65 | 29.65 | 2.52 | 0 | 0 |
| V12 | 29.71 | 29.71 | 2.52 | 0 | 0 |
| V13 | 29.71 | 29.71 | 2.52 | 0 | 0 |
| V14 | 29.71 | 29.71 | 2.52 | 0 | 0 |
| V15 | 29.71 | 29.71 | 2.52 | 0 | 0 |
| V16 | 29.71 | 29.71 | 2.52 | 0 | 0 |
| V17 | 29.71 | 29.71 | 2.52 | 0 | 0 |
| V18 | 29.71 | 29.71 | 2.52 | 0 | 0 |
| V19 | 29.71 | 29.71 | 2.52 | 0 | 0 |
| V20 | 29.71 | 29.71 | 2.52 | 0 | 0 |

## Interpretation
- The Pion-based local relay forwarded one actual decodable VP8 source to **20 simultaneous browser PeerConnections**; 20 elements concurrently decoded and advanced playback frames at ~29.65–29.71 FPS.
- Publisher output declined from ~29.88 FPS at 10 viewers to ~29.71 FPS at 20 viewers: a difference of ~0.17 FPS (<1%) in this single run; this is not evidence that performance remains flat at arbitrary scale.
- The combined viewer-side received-media estimate at 20 is ~50.41 Mbps, versus Alice outbound ~2.52 Mbps, consistent with relay fan-out to 20 local receivers. These are byte-counter estimates, not line-rate benchmarks.
- The experiment **does not** measure SFU-only CPU/memory at 20 real-video viewers, network delay/jitter on WAN, multiple remote devices, TURN, peak capacity, or long-term stability. Prior T-10C CPU/memory figures were for synthetic RTP and are not interchangeable with real-video figures.
- The single browser and computer host both sender and 20 decoders, so browser/hardware constraints are confounded with SFU throughput; independent-device tests are separate future work.
- The stats reflect an approximately 17-second stable interval within a 20-second stage; short startup/transient glitches and the cumulative `framesDropped` values observed before each phase are not erased by the zero-delta result.

## Reproduction and acceptance
1. Run Node API (`127.0.0.1:3101`), Go/Pion (`127.0.0.1:3002`), and Vite (`localhost:5173`).
2. Open `http://localhost:5173/t12-lab.html` and start a screen capture with moving content.
3. Ramp to 2, 5, 10, and 20 viewers; keep the page visible and measure each stage for 20 seconds after warm-up.
4. Export JSON; run `py .\tools\t12\analyze.py <path-to-exported-json> --out .\reports\t12\analysis.txt`.
5. Acceptance is exploratory: every viewer >=20 decoded FPS and >=70% of source FPS, playback >=15 FPS and >=60% of decoded FPS, stable connection, sufficient stats, and <=5% hidden visibility samples.

## Release status
**T-12 browser-local real-video fan-out objective: PASS.** Do not interpret this result as a validated 20-user public service level; network tests and security review remain out of scope for this experiment.
