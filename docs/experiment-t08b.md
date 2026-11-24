# T-08B — Authorization API outage and media fail-closed behavior

**Version:** v0.8 research patch (pending validation on the user's v0.7 lab).

## Question and hypothesis

What should the WebRTC relay do if its membership authority (Node API) is unavailable? We require new connections to be **denied** and existing media endpoints to be **closed** on the first unsuccessful revalidation, rather than allowing unverified delivery. But an outage must **not** be logged as proof that membership was revoked.

This trades availability for access-control safety. This prototype uses a 100 ms *poll schedule* and an 800 ms revalidation timeout, **not a guaranteed cutoff time**.

## Failure classification

| API outcome | Admission | Existing relay connection | Audit / interpretation |
|---|---|---|---|
| HTTP 200 + matching role | Allow | Continue | Verified membership |
| HTTP 401 / 403 / 404 | Reject (4001) | Close (4003) | `authorization_rejected`, `membership_denied` |
| HTTP 200 + changed role | Role is accepted for a *new* session if valid | Close (4003) | `authorization_rejected`, `role_mismatch` |
| HTTP 429 / 5xx, timeout, network error, invalid JSON | Reject (1013) | Close (1013) | `authorization_unavailable`, `authorization_api_unavailable` |

This test uses fail-closed *immediately on the first failed revalidation* without retry or fail-open grace. Previously connected clients must reconnect manually after service restoration. WebSocket close codes are observable diagnostics, not authentication primitives or guarantees of RTP delivery cutoff.

## Synthetic automated tests

Run `cd sfu; go test ./...` after applying the patch. New tests cover:

- Classification of 401/403/404 versus 429/5xx and malformed successful responses.
- Timeouts against an actual local `httptest.Server`.
- A watcher performing real HTTP membership checks, then responding to 503 or 403.
- Cancelled watcher not generating a false revocation.

The policy and validator tests run without real camera feeds or minors' data. They do **not** prove transport-level closure in real browsers.

## Manual T-08B laboratory procedure (optional, after automated tests)

1. Start Node (`npm run dev`) and the Go relay (`cd sfu; go run .`).
2. Connect synthetic Alice and Bob in the SFU lab; verify Bob decodes moving video.
3. Stop the Node API process (not the Go relay) and observe that Bob's relay transport closes; record the `authorization_unavailable` event and code 1013. If the single `npm run dev` process stops both Vite and Node, the Go log plus browser WebRTC stats suffice.
4. Restart Node; note in-memory sessions are lost, so create a fresh room and synthetic users. Verify new admissions are denied while Node is unavailable, then work again when the API is restored.
5. In a **separate** fresh test, revoke an authorized viewer while Node is available; expect `membership_denied` and code 4003, not 1013.

Do not conduct outage experiments against Discord or third-party services. Keep test sessions local and synthetic.

## Measurement plan and limitations

Record the backend fault time separately from the relay's first failed revalidation and the observer's last decoded frame. Clock synchrony and buffering must be documented. An `authorization_unavailable` event is **not** evidence of a deliberate membership revocation. Because the relay depends on a central authorization service, API outages reduce availability for everyone; production designs require resilience analysis, rate limits and a justified risk policy.

Future T-08A/T-08C: multiple simultaneous viewers, controlled API latency/failures, cross-room isolation, and media-level metrics, with CPU/network measurements.
