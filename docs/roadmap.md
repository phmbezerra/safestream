# Research and Engineering Roadmap

Milestones are sequential research gates, not delivery dates or commitments to deploy.

## M0 — Foundation (current)

- [x] Public repository initialized
- [x] Problem statement, threat model, requirements and contribution guidance drafted
- [ ] Choose license and code of conduct
- [ ] Review primary decision documents and create source-to-requirement traceability
- [ ] Define synthetic scenario fixtures and ethics protocol

**Exit criterion:** reviewed scope, explicit open questions and safe testing rules.

## M1 — Architecture and local lab

- [ ] Architecture decision records: signaling, media topology, auth and revocation
- [ ] Threat-boundary diagram and data inventory
- [ ] Local React/TypeScript + Node/WebRTC proof of concept
- [ ] Scripts to create synthetic publisher/viewer accounts

**Exit criterion:** two consenting test clients connect to a local room with no recording by default.

## M2 — Prevention MVP

- [ ] Authenticated room membership and server-enforced roles
- [ ] Authorized publishing and joining
- [ ] Revocation and forced termination
- [ ] Automated negative authorization tests

**Exit criterion:** reproducible tests include bypass attempts and revocation measurements.

## M3 — Response MVP

- [ ] Stop-stream, leave, block and safety-report user flows
- [ ] Test moderation queue, audit trail and access controls
- [ ] Incident drill using harmless scripted scenarios

**Exit criterion:** report lifecycle and intervention latency can be measured.

## M4 — Evaluation

- [ ] Run test matrix over reliability, load and failures
- [ ] Publish latency distributions and risk analysis
- [ ] Audit collected data and retention behavior
- [ ] Publish limitations and unresolved threats

**Exit criterion:** results are independently reproducible and do not overclaim.

## M5 — Optional research extensions

Evaluate age assurance, client-side inference, selective safety signals and independent review **only after** privacy, security, ethics and feasibility assessments. No biometric collection or real-world content analysis by default.

## M6 — External publication

- [ ] Technical report or white paper
- [ ] Demo and architecture overview
- [ ] Submit a concise, non-confidential proposal through an appropriate official channel

External acceptance, integration or regulatory authorization are **not** project milestones under our control.
