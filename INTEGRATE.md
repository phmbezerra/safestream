# Integration into the existing safestream repository

This ZIP contains a new top-level `README.md` that is a lab guide. **Keep the existing repository README unchanged.** Copy the lab guide as `docs/lab-v0.2.md`, then copy:

- `package.json`, `.gitignore`
- entire `server/` and `web/` directories
- `docs/adr-001-media-topology.md`

Run `npm install`, `npm test`, `npm run dev` from repo root. Do not commit `node_modules`.

Suggested commit: `feat(lab): add local WebRTC signaling proof of concept`.
