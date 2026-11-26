# T-13 — Local Wi-Fi Cross-Device VP8 and Selective Revocation

**Status: FUNCTIONAL TEST PASSED — 2026-11-26.**

The T-13 experiment successfully demonstrated real WebRTC VP8 streaming between a Windows PC and an Android device over a trusted local Wi-Fi network, including server-enforced selective revocation.

The experiment also verified that revoking one viewer does not interrupt another authorized viewer.

This is an experimental LAN configuration, **not an internet-ready or production-secure deployment**. Network-performance limitations remain under investigation.

## 1. Scope

- Windows PC acting as publisher, with an Android phone and another browser acting as viewers.
- All devices connected to a trusted local Wi-Fi network.
- Node.js API, Go/Pion SFU, WebRTC and VP8 video.
- Single-use invitations, room membership and server-enforced selective revocation.
- HTTP and WebSocket connections restricted to the configured local network for this experiment.
- No production credentials, confidential media or private user information.

The local HTTP/WS signaling traffic is not protected by TLS.

The SFU has access to media transport packets. This experiment does not establish end-to-end encryption against the SFU.

Public networking, NAT traversal, TURN and production TLS remain outside the T-13 scope.

## 2. Environment

| Component | Configuration |
|---|---|
| Publisher | Windows PC — Alice |
| Revoked viewer | Android / Chrome — Bob |
| Authorized viewer | Desktop browser — Carol |
| Network | Private Wi-Fi LAN |
| Example LAN IP | `192.168.1.19` |
| Node API | TCP 3101 |
| Pion SFU signaling | TCP 3002 |
| Desktop Vite UI | TCP 5173 (localhost) |
| Mobile Vite UI | TCP 5174 |
| WebRTC ICE | UDP 42000–42199 |
| Video codec | VP8 |

The IP address and local filesystem paths are examples from the tested environment and must be adapted when reproducing the experiment.

## 3. Installation

The T-13 implementation is already incorporated into the repository. The previously used `safestream-v16-t13-lan` installer is a local development helper and is **not required to run the committed implementation**.

Clone and check out the experimental branch:

```powershell
git clone https://github.com/phmbezerra/safestream.git
cd safestream
git switch feat/t13-lan-interop

npm ci
npm test
npm run build

cd sfu
go test ./...
go build ./...
cd ..
```

Requirements include compatible Node.js, npm and Go installations.

Stop any previously running SafeStream services before starting the LAN experiment.

### Check network configuration

```powershell
Get-NetIPAddress -InterfaceAlias 'Wi-Fi' -AddressFamily IPv4

Get-NetConnectionProfile -InterfaceAlias 'Wi-Fi'
```

Confirm that the selected Wi-Fi network is trusted and has the `Private` network profile.

Do not use public Wi-Fi, guest Wi-Fi or an untrusted shared hotspot.

## 4. Temporary Windows Firewall Configuration

This section replaces the untracked `firewall.ps1` helper with reproducible PowerShell commands.

Run PowerShell **as Administrator**.

Set the LAN IP to the address of the PC hosting SafeStream:

```powershell
$LanIP = '192.168.1.19'

$profile = Get-NetConnectionProfile -InterfaceAlias 'Wi-Fi'

if ($profile.NetworkCategory -ne 'Private') {
    throw 'T-13 requires a trusted Private Wi-Fi network.'
}
```

Create temporary inbound rules restricted to the selected Wi-Fi interface, local IP and local IPv4 subnet:

```powershell
New-NetFirewallRule `
  -DisplayName 'SafeStream T13 Wi-Fi TCP' `
  -Direction Inbound `
  -Action Allow `
  -Profile Private `
  -InterfaceAlias 'Wi-Fi' `
  -LocalAddress $LanIP `
  -RemoteAddress LocalSubnet4 `
  -Protocol TCP `
  -LocalPort 3101,3002,5174

New-NetFirewallRule `
  -DisplayName 'SafeStream T13 Wi-Fi UDP' `
  -Direction Inbound `
  -Action Allow `
  -Profile Private `
  -InterfaceAlias 'Wi-Fi' `
  -LocalAddress $LanIP `
  -RemoteAddress LocalSubnet4 `
  -Protocol UDP `
  -LocalPort '42000-42199'
```

These rules are temporary and must be removed after the experiment. Do not configure router port forwarding.

## 5. Start the Services

Use four separate PowerShell terminals. The commands below assume the repository is located at `C:\Users\paulo\Downloads\safestream`.

### Terminal A — Node API

```powershell
cd C:\Users\paulo\Downloads\safestream

$env:PORT='3101'
$env:SAFESTREAM_LAN_IP='192.168.1.19'
$env:SAFESTREAM_LAN_ORIGIN='http://192.168.1.19:5174'

npm run dev -w server
```

### Terminal B — Go/Pion SFU

```powershell
cd C:\Users\paulo\Downloads\safestream\sfu

$env:SAFESTREAM_LAN_IP='192.168.1.19'
$env:SAFESTREAM_LAN_ORIGIN='http://192.168.1.19:5174'
$env:SAFESTREAM_NODE_API='http://192.168.1.19:3101'

go run .
```

### Terminal C — Desktop UI

```powershell
cd C:\Users\paulo\Downloads\safestream

npm run dev -w web -- --port 5173 --strictPort
```

### Terminal D — Mobile UI

```powershell
cd C:\Users\paulo\Downloads\safestream\web

npx vite --host 192.168.1.19 --port 5174 --strictPort
```

Verify both backend health endpoints from the PC:

```powershell
Invoke-RestMethod http://192.168.1.19:3101/api/health

Invoke-RestMethod http://192.168.1.19:3002/health
```

Desktop laboratory URL:

`http://localhost:5173/t13-lab.html?host=192.168.1.19`

Android laboratory URL:

`http://192.168.1.19:5174/t13-lab.html`

Loading the mobile page only confirms HTTP connectivity. Working WebRTC must be verified separately.

Some browsers may restrict functionality on insecure HTTP origins. Record compatibility issues rather than weakening browser security settings.

## 6. Experimental Procedure

1. Alice creates a demonstration session and a room, then starts publishing real VP8 screen/window video.
2. Bob creates a separate demonstration session, joins using a single-use invitation and connects as viewer.
3. Bob enables `Ignore revocation notification locally` before connecting.
4. Carol creates a separate session, joins the same room with a different single-use invitation and connects as viewer.
5. Confirm Bob and Carol are simultaneously decoding video before revocation.
6. Alice revokes only Bob's room membership.
7. Bob does not manually disconnect, close his page or terminate his local PeerConnection.
8. Continue observing for at least 14 seconds after revocation, preferably 20 seconds.
9. Export browser evidence from Alice, Bob and Carol.

The expected behavior is that Bob stops receiving new RTP packets and decoding new video frames, while Alice continues publishing and Carol continues decoding.

Evidence exports must not contain credentials, invites, SDP, ICE candidates or media content.

## 7. Experimental Results — 2026-11-26

**Result: PASS — selective revocation and isolation demonstrated.**

The final test used the same room for all three participants.

Alice issued a successful revocation request for Bob. Bob's WebSocket was closed with code `4003`, indicating that room membership had been revoked.

Bob was configured to ignore the revocation notification locally, preserving the client-side PeerConnection for the experiment.

Despite this, his media reception stopped.

Meanwhile, Alice continued encoding video and Carol remained connected and continued receiving and decoding VP8.

### Quantitative evidence

During an approximately 20-second observation window following Alice's revocation request:

| Metric | Observed result |
|---|---:|
| Alice — additional encoded frames | 608 |
| Bob — additional received RTP packets | 0 |
| Bob — additional decoded frames | 0 |
| Carol — additional decoded frames | 600 |
| Carol — additional received RTP packets | 5,241 |
| Carol — WebRTC connection | Connected |

Bob's final counters stabilized at:

- `framesDecoded = 492`
- `packetsReceived = 4196`

These counters remained unchanged during the required observation period.

The result demonstrates that revoking Bob did not require his client to cooperate with a notification and did not interrupt Carol's authorized media stream.

### Timestamp limitations

Alice recorded a successful HTTP revocation event at approximately `2026-11-26T22:40:24.840Z`.

The different devices did not have an independently verified common clock.

Consequently, timestamps from Alice and Bob must not be subtracted to claim an exact enforcement latency.

The T-13 conclusion is based on sustained media-counter behavior, not a cross-device latency measurement.

### Automated validation

The following checks were completed successfully:

| Check | Result |
|---|---|
| Node.js server tests | 18 passed, 0 failed |
| Frontend build | Passed |
| Go package tests | Passed |
| Go build | Passed |
| Real LAN VP8 streaming | Demonstrated |
| Server-side selective revocation | Passed |
| Continuity of authorized viewer | Passed |

These results establish functional behavior in the tested laboratory configuration, not comprehensive security certification.

## 8. Performance Observations and Limitations

Earlier cross-device testing revealed intermittent disconnects, packet loss and video freezes when the Android viewer was farther from the Wi-Fi router.

Moving closer to the router was associated with significantly improved reception.

A separate stable observation interval produced approximately 30 FPS at the publisher and Android viewer, without additional RTP packet loss or dropped frames in that interval.

However, browser-reported freeze events were still observed.

Therefore:

- Selective revocation is functionally validated.
- Network stability and playback smoothness are not universally guaranteed.
- Wi-Fi signal quality and device/browser behavior require further investigation.
- Public internet, mobile data, TURN, NAT traversal and production security were not validated.

## 9. Cleanup

Stop all four development services.

In an elevated PowerShell window, remove temporary T-13 firewall rules:

```powershell
Get-NetFirewallRule -DisplayName 'SafeStream T13 Wi-Fi*' `
  -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule
```

Verify cleanup:

```powershell
Get-NetFirewallRule -DisplayName 'SafeStream T13 Wi-Fi*' `
  -ErrorAction SilentlyContinue

netsh advfirewall show currentprofile
```

Expected result:

- No matching temporary T-13 firewall rules remain.
- Windows Firewall stays enabled.
- The normal inbound-blocking policy remains active.

This cleanup was performed successfully in the tested environment.

When `SAFESTREAM_LAN_IP` and `SAFESTREAM_LAN_ORIGIN` are not set, the project retains its original localhost-oriented development configuration.

## 10. Conclusion

**T-13 functional objectives were achieved in the tested LAN environment.**

The experiment demonstrated real VP8 transmission between PC and Android, authenticated room participation, server-enforced revocation of a non-cooperative viewer and continued media delivery to an independent authorized viewer.

Future work should address playback stability, secure deployment requirements and cross-network connectivity.

The experiment does not establish production readiness, end-to-end media confidentiality against the SFU, or precise revocation latency.