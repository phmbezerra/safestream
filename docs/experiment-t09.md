# T-09 — Cross-room isolation and adversarial authorization checks

**Status:** Experimental test suite for SafeStream v0.10; pass/fail must be recorded from a real run after installation. **No automatic claim of Pion media-plane packet isolation.**

## Security hypothesis

A valid synthetic session token is a *global session credential*, not a token scoped to a room. For each room, the Node API must independently verify the user's membership. A session may legitimately have different roles in different rooms. Supplying a foreign room ID, an invite from a different room, or a forged role field must not bypass that per-room authorization.

T-09 tests two rooms independently:

- Room A: Alice (publisher), Bob (viewer)
- Room B: Diana (publisher), Carol (viewer)
- Eve: not a member of either room

The RTP test authority additionally makes Alice a viewer in room B, ensuring the media server uses the role returned by the authorization API *for that room*, not the `role` claimed by a browser.

## T-09 automated tests

1. **Node HTTP boundary:** valid sessions cannot query or revoke another room without membership; one-use invites do not cross room boundaries; invalid join attempts do not mutate membership.
2. **Node WebSocket signaling:** foreign-room admission is refused with 4001. A cross-room target ID cannot receive an SDP message. The within-room positive controls must still work in both rooms.
3. **Node JPEG transport:** distinct synthetic frame markers sent in A and B are delivered only within their respective rooms. After revoking Bob in A (4003), Carol in B keeps receiving frames and membership remains intact.
4. **Go/Pion WebSocket admission:** the real relay handler checks membership against a local synthetic authority. Bob cannot authenticate in room B; Carol cannot authenticate in A; Eve cannot enter either room. Browser-provided role claims are ignored.
5. **Go/Pion track separation:** the registry creates *different `TrackLocalStaticRTP` instances* for A and B; a viewer in one room is never present in the other room's registry.
6. **Go/Pion revocation isolation:** revoking Bob in A causes 4003 while Carol's authorized endpoint in B remains attached after multiple authorization polls.

Go integration tests use `httptest` and real Gorilla WebSocket connections; they do not open port 3002. They do not negotiate full publisher/viewer DTLS-SRTP media sessions or decode real VP8 frames. Thus, the tests prove **authorization boundary and relay track separation**, not a packet-level bound under adverse network conditions.

## Commands

From the repository root:

```powershell
npm test
npm run build
cd sfu
go test ./...
go test -race ./...
```

Run with synthetic local data only, not against Discord or third-party services. If a test fails, preserve terminal output and do not commit until the cause has been investigated.

## Expected result and limitations

Expected: all existing tests remain passing; Node T-09 tests and Go T-09 tests pass. **Do not assert those expectations as observed evidence until the Windows tests finish.**

Known limitations: one Go Pion test instance uses a mocked Node authorization authority; the other Node tests use an actual in-process local API. No full Pion RTP forwarding across two WebRTC rooms is exercised yet. No network impairments, load, audio, scale or concurrent API state writes are evaluated. Those require a future T-09B end-to-end media isolation benchmark and could expose further implementation defects.

## Evidence checklist

Record `git status --short`, Node test totals, Go package tests, race detector results and any failing assertion. The local v0.9 state file `.local/safestream-state.json` must remain ignored. Test logs should not contain bearer secrets or real media.

## T-09B — Two-room WebRTC functional validation

**Date:** 2026-11-24
**Environment:** Local Windows laboratory
**Result:** PASS (manual functional validation; one observed run)

### Scenario

- Room A: Alice (publisher), Bob (viewer)
- Room B: Diana (publisher), Carol (viewer)
- Two simultaneous, visually distinct WebRTC video streams
- Bob revoked while Room B remained active

### Observations

- Bob was denied continued membership after revocation.
- Bob's media WebSocket closed with code 4003.
- Bob's subsequent connection attempt was rejected with code 4001.
- Diana and Carol remained connected in Room B.
- Carol's observed cumulative statistics included 4,791 decoded
  frames and 41,684,066 received bytes.
- The operator reported all six functional checklist criteria passed.

### Limitations

- Single-host, single-run manual experiment.
- Browser statistics are cumulative and do not establish precise
  packet-delivery cutoff times.
- No packet-level RTP cross-room capture was performed.
- No production security or latency guarantee is claimed.

### Automated validation

- Node.js: 18/18 tests passing.
- Go/Pion: all tested packages passing.
- Go race detector: no data races detected in the executed tests.


## T-09B — Two-room WebRTC functional validation

**Date:** 2026-11-24
**Environment:** Local Windows laboratory
**Result:** PASS (one manual functional run)

### Scenario

- Room A: Alice (publisher), Bob (viewer)
- Room B: Diana (publisher), Carol (viewer)
- Two simultaneous WebRTC video streams
- Bob revoked while Room B remained active

### Observations

- Bob received only Alice's video before revocation.
- Carol received Diana's video.
- Both viewers showed increasing media counters.
- Bob's media connection closed with code 4003.
- Bob's subsequent connection attempt was denied with code 4001.
- Carol remained connected in Room B.
- Carol's cumulative counters included 4,791 decoded frames
  and 41,684,066 received bytes.
- All six manual functional criteria were reported as passed.

### Limitations

- Single-host, single-run experiment.
- No packet-level RTP cross-room capture.
- Cumulative counters do not establish exact delivery cutoff.
- No production security guarantee is claimed.

### Automated validation

- Node.js: 18/18 tests passing.
- Go/Pion: all tested packages passing.
- Go race detector: no data races detected in executed tests.
