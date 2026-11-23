# SafeStream Lab v0.2 (experimental overlay)

This package adds an **independent local research prototype** to the SafeStream repository. Copy its files into the repository root, preserving the existing `docs/` research documents. The included `README.md` is intended as a temporary lab guide; **do not overwrite your main README**. Instead, copy its contents to `docs/lab-v0.2.md`.

## Quick start (Node.js 22+ recommended)

```powershell
npm install
npm test
npm run dev
```

Open http://localhost:5173 in two browser windows (a normal window and incognito are useful):

1. Create two demo identities with different labels.
2. First window: create room, generate one-use invite.
3. Second window: enter room ID and invite; join as viewer.
4. First window: allow screen sharing in your browser. A viewer should see the shared screen when the WebRTC connection succeeds.
5. Try access-control tests with `npm test`.

**Security limitations:** This is a localhost research demo, not a secure communication service. Viewer removal severs signaling but may not end existing P2P media flows. The test accounts are not real authentication; possession of the demo token grants access. Anyone with a valid invite can join as viewer. Do not expose this server publicly or test with sensitive information. Do not claim compliance with ANPD measures.

## Expected tests

- Anonymous calls cannot create rooms.
- Nonmembers cannot retrieve room details.
- Invite codes work once.
- Viewers cannot create invitations, revoke members or send WebRTC offers.
- Revoked members cannot access room endpoints.

## Next steps

Implement a server-controlled media topology (SFU), robust revocation, report workflow, and measurable safety controls. See `docs/adr-001-media-topology.md` for the current design tradeoff.
