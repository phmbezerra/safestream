# ADR-002: Experimental server-controlled RTP forwarding (SafeStream v0.7)

**Status:** Proposed, executable prototype; full media pipeline requires external Go dependencies and browser integration testing.

## Context

T-04B showed that a modified client can keep an established direct P2P connection alive after signaling revocation. T-05/T-06 evaluated a server-controlled JPEG gateway, reporting selective denial of future frames under local test conditions. We now need an **actual WebRTC media path** with a server-owned transport to assess enforcement vs. privacy/latency trade-offs.

## Decision

Introduce **a separate Go/Pion relay** bound to `127.0.0.1:3002` for one VP8 screen-share publisher and multiple viewers per room. Preserve the existing React/Node WebRTC P2P and JPEG gateway labs unchanged. Serve a separate `/sfu-lab.html` test UI from Vite.

1. The existing Node API on `127.0.0.1:3001` remains the **authorization source of truth**.
2. Every client authenticates to the media relay by sending its synthetic session token and room ID as the initial WebSocket message (never in a query string).
3. The relay asks the Node API for the server-verified role; it does **not** accept a role provided by the browser.
4. Each participant has a distinct **server-owned RTCPeerConnection**. A publisher sends VP8 RTP to the relay; the relay forwards received RTP on an in-memory TrackLocalStaticRTP to authorized viewer transports.
5. The relay **rechecks** session membership every 100 ms (lab-only policy). When membership is missing, the server closes the viewer's own WebRTC transport. Ignoring UI notifications cannot keep the media transport open indefinitely.
6. WebSockets are bound to loopback, with an exact development `Origin` check, a 64 KiB read limit, and no stream recording.

## Expected observable result

After Bob is revoked, his WebSocket closes with 4003; his `inbound-rtp.bytesReceived` / `framesDecoded` stop growing after in-flight buffering settles. Authorized Carol continues receiving. Bob's attempt to reconnect gets 4001. The experiment should instrument and compare **media stats** and **transport close timestamps**, rather than infer revocation solely from HTTP replies.

## Privacy and trade-offs

This relay terminates DTLS-SRTP and has the ability to read the media payload; it therefore **does not provide E2EE against the server**. RTP packets remain in memory, are not recorded intentionally, but still pass through a new trust boundary. A future design could explore insertable streams/E2EE group keys, with carefully documented implications for moderation and revocation.

## Known limitations

- One publisher / VP8 video track per room; no audio, renegotiation, simulcast, bandwidth adaptation, NACK/RTX or guaranteed recovery on loss.
- Designed for a single Windows machine with loopback; no TURN, TLS, hardening, durability or cross-instance coordination.
- Membership polling is **not instantaneous** and may miss a rapid grant/revoke race between polls; this is not a production authorization system. Network buffers may deliver packets already in flight after termination.
- The relay is not a complete industry-grade SFU, and `100 ms` is a polling interval, **not** an SLA or media-delivery deadline.
- Production-ready safety would also require content-independent controls, age assurance research, abuse reporting, audit trails, red-team tests and privacy/data protection assessment.

## Validation gates

- Run `go test ./internal/auth` and `go test ./...` after `go mod tidy` resolves Go dependencies.
- Confirm Alice video to Bob and Carol in three browser contexts.
- Confirm Bob's inbound bytes/decoded frames stop after revocation while Carol keeps receiving.
- Repeat with the local "ignore notices" option enabled; observe real transport behavior.
- Report any connection failure honestly. Do not label a suite as passed until actually executed.

## References

- https://github.com/pion/webrtc/tree/main/examples
- https://github.com/pion/example-webrtc-applications/tree/main/sfu-ws
- https://pkg.go.dev/github.com/pion/webrtc/v4
