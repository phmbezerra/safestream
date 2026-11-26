# T-11B — Selective revocation during decodable VP8 playback

**Status:** PASS — one exploratory three-participant local WebRTC VP8 trial on 2026-11-26. Analyzer PASS; not a production-capacity, security audit, or immediate packet cutoff claim.

## Validated observation — 2026-11-26 (UTC)

- **Room:** `gSXePWzM7Sx9`; Alice publisher, Bob revoked viewer, Carol unaffected viewer; all three evidence exports matched this room.
- **Media:** actual browser screen capture encoded as decodable VP8, not the earlier timer-driven synthetic canvas source. Carol received 1320×590 video.
- **Revocation:** Alice emitted `revoke_http_ok` targeting Bob at **07:10:12.516Z** (HTTP success event; the export does **not** preserve the numeric HTTP status). Bob's SFU WebSocket closed with code **4003**, reason `room membership revoked`, at **07:10:12.579Z** (63 ms after success event). This **is not** an RTP cutoff latency measurement.
- **Non-cooperative viewer:** Bob's JSON recorded `ignoredLocally=true` and `keptLocalPc=true`, confirming that the client did not proactively shut down its WebRTC PeerConnection on notification.
- **Pre-revocation, [-8,-1] seconds:** Alice ~**30.02 encoded fps** (190 frames over 6.3 s); Bob ~**30.04 decoded fps** (180/6.0 s); Carol ~**30.00 decoded fps** (180/6.0 s).
- **Post-revocation, [+2,+12] seconds:** Alice ~**30.00 encoded fps** (241/8.0 s) and Carol ~**30.00 decoded fps** (270/9.0 s).
- **Bob's quiet interval:** **07:10:14.516Z–07:10:22.516Z**, starting 2 seconds after the successful revocation. Valid browser samples spanned 7.4 seconds; all four counters remained available and unchanged: RTP packets, RTP bytes, decoded frames, and rendered/playback frames. All deltas **0**.
- **Extended Bob observation:** From **07:10:13.025Z** to **07:10:26.643Z** (13.618 seconds), `packetsReceived=6112`, `bytesReceived=6790231`, `framesDecoded=601`, and `playbackFramesTotal=601` did not change. Browser PeerConnection became `disconnected` at **07:10:18.932Z**; the counters were already flat before that state change.
- **Carol positive control:** Stayed `connected`, with `framesDecoded` increasing from **343 at 07:10:13.025Z** to **829 at 07:10:29.277Z**, corresponding to **486 new decoded frames over 16.252 s (~29.90 fps)**, with no reported packet loss or new freezes in the post-revocation interval.
- **Disposition:** **PASS for this local trial**. The observations support selective transport/media revocation with uninterrupted delivery to an authorized viewer. They do not establish performance under external networks, precise packet cutoff time, or persistent cryptographic control of media already received.

The initial sample following revocation was at 07:10:13.025Z, approximately 0.509 seconds after Alice's HTTP-success event, and Bob's counters had advanced since the preceding pre-event sample. This is not necessarily a post-revocation leak: the two samples straddle the event, and queued/in-flight RTP can be counted during the transition. Only the stated **quiet interval** supports the zero-delta claim.

## Research question

Can the Pion relay stop forwarding an actual, decodable WebRTC VP8 screen capture to a revoked viewer (Bob), while a separately authorized viewer (Carol) continues decoding? Bob is deliberately non-cooperative and keeps his own local PeerConnection open after receiving SFU WebSocket close 4003.

## Scope and prerequisites

- T-10A/B/C completed with synthetic packets; T-11A demonstrated decoded video but its canvas source was throttled when hidden. Screen capture was observed to remain smooth in one local trial.
- Three browser windows on the same Windows host; loopback Node API `127.0.0.1:3101`, Go/Pion relay `127.0.0.1:3002`, Vite `localhost:5173`.
- Alice shares a moving screen/window (do not enable synthetic canvas), Bob and Carol connect to the **same room** using **different one-use invites**.
- Bob checks **Ignore revocation notification locally** *before* connecting; Carol does not. This tests server-side enforcement independently of Bob's UI behavior.
- No production sessions, other benchmark clients, personally identifiable screen content, or audio capture.

## Procedure

1. Open `http://localhost:5173/t11b-lab.html` in three separate browser windows. Reload all three before a new trial to clear in-memory samples.
2. Alice creates a demo session, creates a room, starts real screen/window capture, and connects the SFU.
3. Alice generates one invite for Bob. Bob creates his own session, joins that room, checks **Ignore revocation notification locally**, and connects. Alice creates **another** invite for Carol; Carol joins and connects.
4. Confirm both Bob and Carol show moving video and nonzero `framesDecoded` for **at least 8 seconds** before revoking.
5. Alice presses **Refresh members**, then **Revoke viewer** next to **Bob** (not Carol).
6. Bob must not press Disconnect. Wait at least **14 seconds** while Alice continues capturing and Carol continues viewing.
7. Export evidence JSON in all three windows *before* disconnecting. Only telemetry/labels are exported; **not** tokens, SDP, invites, or media.
8. Run `py .\tools\t11b\analyze.py <alice.json> <bob.json> <carol.json> --out .\reports\t11b\result.txt`. Analyze the same room and trial only.

## Evaluation

- Alice: HTTP revocation success event targeting Bob, `screen_capture` source marker, and outbound encoded frames continuing after revocation.
- Bob: WS close code **4003** and `ignoredLocally=true`. During an 8-second **quiet interval**, starting no earlier than 2 seconds after HTTP success and 1 second after socket closure, no new decoded/displayed frames or RTP payload/packets **when counters remain available**.
- Carol: positive-control inbound VP8 decoding continues, with a descriptive before/after comparison. Minimum observed post-revoke decoded rate of 5 fps and at least 60% of before-revoke rate (these are exploratory acceptance thresholds, not production service levels).
- When WebRTC inbound RTP reports disappear after the PeerConnection closes, the analyzer reports **INCONCLUSIVE**, rather than mistaking missing counters for zero traffic. Use T-10B for existing transport-level revocation evidence.
- The script prints `PASS`, `FAIL`, or `INCONCLUSIVE`, not a sub-second revocation latency measurement.

## Limitations

- Loopback and one publisher/two viewers, real screen sharing but single machine and no adverse network emulation.
- Browser stats are sampled; `getStats()` counters may disappear or reset on transport closure. No promise of an instantaneous or packet-perfect cutoff.
- Browser and JavaScript wall clock sample times approximate event ordering. A grace interval excludes in-flight media and cannot establish an exact enforcement timestamp.
- `video.getVideoPlaybackQuality().totalVideoFrames` is a playback indicator, not proof of RTP transport state.
- Screen capture frame rates depend on source motion, browser, scheduling and capture mode. This experiment excludes audio and external TURN.
- Application does not claim E2EE against the SFU. Avoid sharing sensitive content.

## Reproducibility

Record browser version, `npm test`, `npm run build`, `go test -count=1 ./...`, Go race test where supported, the three original JSON exports, and the analyzer output. Raw JSON should stay in ignored `reports/` or local Downloads; avoid checking telemetry into Git. Do **not** commit a PASS conclusion until the end-to-end trial succeeds.
