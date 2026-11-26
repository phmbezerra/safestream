# T-13 — Local Wi-Fi cross-device VP8 and selective revocation

**Status: NOT YET TESTED.** This is an opt-in laboratory configuration and not an internet-ready deployment. T-12 loopback performance results do not establish cross-device behavior.

## Scope

- Windows publisher PC on trusted, private Wi-Fi; viewer phone/tablet on **the same Wi-Fi and IP subnet**. Do not use guest or isolated Wi-Fi.
- Only synthetic demo identities and non-sensitive moving screen/window video. The local HTTP/ws traffic is **not protected by TLS**; bearer tokens should never be real credentials.
- Node API port 3101, Pion WS port 3002, Vite phone UI port 5174, Pion ICE UDP range 42000–42199. All endpoints bind the explicitly configured Wi-Fi IP; the desktop UI stays on localhost:5173 for screen capture.
- Cross-network/NAT/TURN and production TLS are **deferred** to a separate phase. No router port forwarding or public exposure.
- A T11B-based T13 page demonstrates the protocol but contains no automatic cross-device clock correction. Do **not** infer revocation latency from timestamps on different devices.

## Install (while checked out on `feat/t13-lan-interop`)

From repository root, unzip `safestream-v16-t13-lan.zip` into the root (creates a folder), then:

```powershell
py .\safestream-v16-t13-lan\install.py --dry-run
py .\safestream-v16-t13-lan\install.py
npm test
npm run build
cd sfu
go test -count=1 ./...
cd ..
```

**Stop existing localhost API/Pion processes before starting the LAN instance** so there aren't confusing servers with the same ports.

Check your private Wi-Fi profile and IP:

```powershell
Get-NetIPAddress -InterfaceAlias 'Wi-Fi' -AddressFamily IPv4 | Select-Object IPAddress,PrefixLength
Get-NetConnectionProfile -InterfaceAlias 'Wi-Fi' | Format-List Name,NetworkCategory
```

For trusted Private Wi-Fi only, run **PowerShell as Administrator**, then:

```powershell
cd C:\Users\paulo\Downloads\safestream
.\safestream-v16-t13-lan\firewall.ps1 -LanIP 192.168.1.19 -InterfaceAlias 'Wi-Fi'
```

The script only permits inbound connections to that Wi-Fi address from the Wi-Fi subnet. It creates temporary rules with names starting `SafeStream T13 Wi-Fi`. **Do not use it on a public/shared hotspot.**

## Start four services in four terminals

**Terminal A — Node API**:

```powershell
cd C:\Users\paulo\Downloads\safestream
$env:PORT='3101'
$env:SAFESTREAM_LAN_IP='192.168.1.19'
$env:SAFESTREAM_LAN_ORIGIN='http://192.168.1.19:5174'
npm run dev -w server
```

**Terminal B — Pion SFU**:

```powershell
cd C:\Users\paulo\Downloads\safestream\sfu
$env:SAFESTREAM_LAN_IP='192.168.1.19'
$env:SAFESTREAM_LAN_ORIGIN='http://192.168.1.19:5174'
$env:SAFESTREAM_NODE_API='http://192.168.1.19:3101'
go run .
```

**Terminal C — desktop localhost UI**:

```powershell
cd C:\Users\paulo\Downloads\safestream
npm run dev -w web -- --port 5173 --strictPort
```

**Terminal D — phone UI exposed only on Wi-Fi IP**:

```powershell
cd C:\Users\paulo\Downloads\safestream\web
npx vite --host 192.168.1.19 --port 5174 --strictPort
```

From PC:

```powershell
Invoke-RestMethod http://192.168.1.19:3101/api/health
Invoke-RestMethod http://192.168.1.19:3002/health
```

From phone on same Wi-Fi, open **`http://192.168.1.19:5174/t13-lab.html`**. Loading the page proves only HTTP connectivity, not yet WebRTC success. Browsers may restrict RTCPeerConnection on an insecure LAN page; if that happens, record the error and move to an HTTPS approach rather than disabling browser security settings.

## First experiment (no private content)

1. On PC, open **`http://localhost:5173/t13-lab.html?host=192.168.1.19`**. This localhost page may request screen capture because loopback is treated as a trustworthy origin. Use moving synthetic test content, not real private windows.
2. Alice: create session/room and start streaming with the **screen/window capture** option, not a throttled canvas. Keep the desktop lab page open.
3. Alice: create a one-time invite for Bob. Bob on phone creates a new session, joins the **same room**, checks **Ignore revocation notification locally** **before** connecting, and connects as viewer. Check that received VP8 decodes and video visibly moves.
4. Alice: create a *different* invite for Carol. Carol joins from a separate desktop tab as a positive control. Check she can decode while Bob remains connected.
5. Alice revokes Bob, leaving Carol authorized. Bob must not manually disconnect; after a short drain interval, his new RTP/decoded frames should stop while Carol continues. Wait at least 14 seconds.
6. Export the browser evidence from Alice, Bob, Carol. Never export or commit credentials, invites, SDP, ICE candidates or media. The legacy T11B analyzer compares UTC clocks across files and is **not by itself** a reliable cross-device latency estimator unless device clocks are synchronized; preserve original logs for evaluation.

If the phone UI opens but WebRTC fails to connect, check Wi-Fi client isolation, UDP firewall rules and browser secure-context policies before changing Pion logic.

## Clean up

Close the four terminals, and, from elevated PowerShell:

```powershell
.\safestream-v16-t13-lan\firewall.ps1 -Remove
```

The default development behavior remains localhost-only when `SAFESTREAM_LAN_IP` and `SAFESTREAM_LAN_ORIGIN` are unset. This experiment does not promise LAN video performance, TLS, TURN, or off-LAN connectivity.
