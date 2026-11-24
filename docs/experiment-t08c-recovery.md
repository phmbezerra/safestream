# T-08C — Restart recovery with durable revocation (SafeStream v0.9)

**Status:** local experimental implementation; automated tests and manual browser/Pion validation required on the target computer. **Not production-ready.**

## Research question

After an authorization-API outage and restart, can legitimate participants authenticate again **without restoring revoked memberships**?

## Baseline (v0.8)

- Session secrets, users, rooms, members and invitations are volatile Node.js `Map` values.
- Restarting the API creates a fresh store. Former tokens are invalid; the Pion relay fails closed while the API is unavailable.
- The browser client does **not** automatically reconnect media. Old WebRTC connections cannot be resurrected; a new authorization/SDP exchange is required.

## v0.9 — opt-in snapshot-based local lab

Start Node with `SAFESTREAM_STATE_FILE` pointing to an absolute path, such as `<repo>/.local/safestream-state.json`, **before** creating synthetic identities and rooms. Leave the Go relay running separately. Only one Node process may use this state file. The prototype is deliberately opt-in so other existing tests remain ephemeral.

Persisted: `SHA-256(session bearer) -> {id,label}`, room ID, owner ID, and current member IDs, labels and roles. **Raw bearer tokens are never stored.** The 192-bit random tokens are returned only once to the browser and retained in that browser's memory until the page is reloaded.

Not persisted: SDP, RTP, WebSocket/PeerConnection objects, invite codes, media content, or browser-local state. Pending invite codes expire after a restart.

Each membership-changing operation writes a candidate snapshot to a unique file, flushes it, renames it over the snapshot, and *then* modifies live membership. If persistence fails, the server must not report a successful revocation. The attempted revocation is rejected and previous permissions remain active until a successful retry; a production deployment would require an explicit fault response/fail-stop policy. A corrupt or malformed file blocks startup rather than silently resetting permissions. This is a single-process **laboratory snapshot**, not a transactional database: no safe concurrent writers, cluster coordination, backup/restore policy, hardened at-rest integrity, disk-full recovery, crash/power-loss durability SLA, or production session lifecycle.

**Important:** the state file holds access-control metadata. Keep `.local/` outside Git, protect local filesystem access, and do not copy it to public reports. Token fingerprints are not themselves authentication credentials, but a person able to tamper with the state file may be able to alter authorization.

## Expected behaviors

| Test | Expected |
|---|---|
| Start v0.9 persistent API and create Alice/Bob/Carol | Fresh identities and room |
| Restart Node using the same file | Alice/Bob/Carol tokens still recognized |
| Revoke Bob, restart again | Bob's old token still identifies Bob but room membership remains denied (403 / SFU 4001) |
| Carol connects after recovery | Allowed; must initiate a NEW media session |
| Use a pre-restart invite code | Rejected; owner must generate a new invite |
| Corrupt snapshot while API is stopped | API refuses to boot; it must not silently grant/reset room access |
| API unavailable during restart | Pion still closes active media transports with 1013 under T-08B policy |

## Procedure (Windows PowerShell)

1. **Stop the old Node API** and start it independently of Vite; set `$env:SAFESTREAM_STATE_FILE=Join-Path (Get-Location) '.local\safestream-state.json'` from the repository root; run `npm run dev -w server`. Start frontend with `npm run dev -w web` and relay with `cd sfu; go run .` in separate terminals.
2. Open three distinct browser contexts for Alice, Bob, Carol and create **new** identities and a room. Existing ephemeral sessions created before the flag was set are not migrated.
3. Verify media is flowing; revoke Bob and verify the server logs `membership_denied` with code 4003. Stop Node (`Ctrl+C`); confirm Pion fails closed and refuses new admissions with 1013 while offline.
4. Restart Node with **the same** environment variable and state file. Do not reload browser tabs (tokens are only held in memory). From Alice and Carol, click **Refresh members** then **Connect SFU media**. Carol should receive frames after reconnecting. From Bob, try **Refresh members**: API must return HTTP 403. Bob must not rejoin without an explicit new invite from Alice.
5. Record HTTP status, Pion event sequences, and Carol's new media counters. Repeat with fresh room if users lost browser token state. Stop and restart with no token migration assumptions.
6. For the corrupt-state test, stop Node and **back up the file locally** before editing it. Do not test corruption on the only copy of important data.

## Evaluation & limitations

Automated tests cover owner/viewer state restoration, persistence of revocation, absence of bearer secrets/invites, refusal of corrupt state, failure-to-commit safety, and the Node HTTP membership API after restart. They do not benchmark actual RTP cutoff or verify complete end-to-end browser reconnection; that remains a separate manual gate.

The Pion relay still validates membership with Node on admission and periodically afterward. A persistent authorization source does not make media sessions survive a previous fail-closed shutdown. The current demo browser keeps tokens in volatile memory; refreshing tabs loses them, by design.
