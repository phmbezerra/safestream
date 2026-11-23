# T-05 — Server-enforced media forwarding (JPEG relay lab)

**Status:** Prototype; not a selective forwarding unit (SFU), WebRTC relay, production service, or regulatory compliance evidence.

## Research hypothesis

If media travels through a server that verifies membership **at delivery time**, revoking a viewer can prevent new frames from being forwarded to that viewer, even if the viewer's UI ignores revocation messages.

## Experimental design

- Existing SafeStream v0.3 HTTP identity/room/invite endpoints remain unchanged.
- New `/media` WebSocket relay accepts synthetic JPEG frames from room publishers.
- Server verifies publisher role on each frame and viewer membership on every forwarding decision.
- Revocation closes the revoked viewer's *media* socket with code 4003.
- Independent browser lab at `/relay-lab.html` renders frames and exposes a UI option to ignore revocation notification. The server still controls the transport.

## What this comparison can establish

A modified receiver cannot cause the relay to forward additional frames **after** the server-side revocation takes effect, subject to already-buffered frames and network in-flight data. This proof of concept does NOT establish a WebRTC SFU design, cryptographic erasure, erasure of old frames, protection from an untrusted sender, or prevention of out-of-band redistribution.

## Measurements and threats to validity

Record event times on both sides, number of received `frame` messages, last sequence number, and frames received after the server accepted revocation. Clarify that existing buffered frames may still render. Browser and server clocks may differ; prefer server monotonic event sequencing in later experiments. Validate with repeating runs and adversarial network buffering.

## Privacy and scaling

This gateway receives full JPEG image data and therefore loses the privacy property of peer-to-peer media not transiting the server. It has no persistent recording in application code, but transport and infrastructure require separate auditing. The local demo is neither rate-hardened nor suitable for internet exposure. Do not use real personal content or participants outside a consent-based laboratory.

## Running

1. `npm test` to verify the gateway unit/integration checks.
2. `npm run dev` then open `http://localhost:5173/relay-lab.html` in a normal and private window.
3. Create `Alice` and `Bob`, room, invite, and connect the media relay in each window.
4. Alice starts **synthetic moving frames**; Bob observes frame count growing.
5. On Bob, enable *Ignore revocation UI notification* and revoke Bob from Alice.
6. Confirm that Bob's socket closes (4003) and his frame count stops increasing. A last frame may remain visually displayed; that is NOT new media.

Compare with the **separate** v0.4 P2P adversarial lab. Do not assume findings about this JPEG gateway generalize to WebRTC or the Discord service.
