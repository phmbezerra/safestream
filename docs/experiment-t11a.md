# T-11A — Browser-encoded and decoded VP8 video baseline

**Status:** Ready for a local manual experiment. No PASS claimed before collecting real browser statistics.

## Hypothesis

The unmodified SafeStream Go/Pion relay can forward VP8 video *actually encoded by a browser* to a separate viewer browser whose inbound `framesDecoded` grows over time. This is distinct from T-10A/T-10C: those sent synthetic VP8-labelled RTP payloads that were deliberately not decodable video.

## What this changes

This installer **does not change Node API, SFU, authorization logic or the original sfu-lab.html**. It generates `web/public/t11-lab.html` from the existing sfu-lab.html, pointed at the isolated local Node API `http://127.0.0.1:3101` and Go/Pion `ws://127.0.0.1:3002/ws`. The publisher can generate a moving 640×360 canvas at a nominal 30 FPS, which the browser encodes through its WebRTC VP8 implementation. Screen sharing is available by unchecking the synthetic source.

## Manual procedure (Windows)

Use **three persistent PowerShell windows**. Stop any old servers using ports 3101 or 3002 first. Do not enable durable state for synthetic tests.

Terminal 1:

```powershell
cd C:\Users\paulo\Downloads\safestream
Remove-Item Env:\SAFESTREAM_STATE_FILE -ErrorAction SilentlyContinue
$env:PORT = '3101'
npm run start -w server
```

Terminal 2:

```powershell
cd C:\Users\paulo\Downloads\safestream\sfu
$env:SAFESTREAM_NODE_API = 'http://127.0.0.1:3101'
go run .
```

Terminal 3:

```powershell
cd C:\Users\paulo\Downloads\safestream
npm run dev -w web
```

Open `http://localhost:5173/t11-lab.html` in two browser tabs:

1. **Alice**: enter label `Alice_T11`, create demo session, create room, generate one-use invite. Keep **synthetic source checked**, connect media. The browser should show the moving canvas locally.
2. **Bob**: enter label `Bob_T11`, create demo session, enter Alice's room ID and invite, join as viewer, connect media.
3. Keep Alice's tab visible where possible for 15–20 seconds; consider separate browser windows side by side. Browser background throttling can reduce canvas frame generation. No audio is sent.
4. In Bob's tab verify the **moving video appears**, `codec=video/VP8` when available, `framesDecoded` and `packetsReceived` increase across samples, and `videoElement` has nonzero dimensions.
5. Click **Export evidence JSON** on Bob. The filename starts with `t11-bob_t11-...json` and contains stats only; never includes session tokens, invite codes, SDPs or video pixels.
6. Optionally export Alice's evidence too. Do not revoke during the T-11A baseline; selective revocation with real video is a separate T-11B experiment.

## Analysis

From repository root, give the exported Bob file to the analyzer:

```powershell
py .\tools\t11a\analyze.py "$env:USERPROFILE\Downloads\t11-bob_t11-....json"
```

Replace `....` with the actual filename from the browser. The analyzer prints a cautious PASS only when multiple connected viewer samples exist over >= 5 seconds, video decoded-frame counters increase, RTP packets arrive, and real video dimensions are observed. Otherwise it returns INCOMPLETE and explanations.

Do not commit evidence until it has been reviewed. Generated browser JSON should not be uploaded with session secrets or unrelated personal data.

## Measures and limitations

- **`framesDecoded`**: cumulative browser inbound RTP decoded-frame counter. A positive delta is strong evidence of actual decoding; it is distinct from receiving raw RTP.
- **`decodedFpsSample`**: approximate short-window derivative of `framesDecoded`, not a formal display refresh-rate measure.
- **`packetsLost`, `framesDropped`, `freezeCount`, `jitterSeconds`**: browser-reported statistics, which may be missing or browser-dependent. A zero value must not be interpreted as universally supported.
- **`videoWidth`/`videoHeight`**: remote HTML video element dimensions. Combined with decoded frames, useful for manual live playback confirmation.
- Browser `getStats()` does not directly measure glass-to-glass latency, actual on-screen presentation per frame, complete network overhead or SFU throughput. Use simultaneous live visual inspection.
- **Single host / localhost**. No WAN, TURN, congestion simulation, mobile devices, scalability or production safety conclusions.
- No hidden screen/audio capture: the generated motion source is a synthetic canvas, and screen sharing requires manually unchecking the box and granting browser permission.
- Do not claim real VP8 performance based on the T-10 synthetic RTP results.

## Evidence checklist

Record Node/Pion `/health`, browser family/version, `framesDecoded` and `packetsReceived` deltas, actual `codecMimeType` if exposed, observed moving video and any playback failure. Keep raw files locally and append dated findings only after a real run.
