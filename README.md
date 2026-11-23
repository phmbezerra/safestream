# SafeStream

**Privacy-Preserving Safety Architecture for Live Communication**

SafeStream is an independent, open-source-intended research and engineering project exploring how live communication platforms can reduce serious safety risks, particularly those affecting children and adolescents, while minimizing intrusion into private communications.

> **Status: planning (v0.1).** No functional safety controls, age-assurance services, automated detection models, or Discord integration have been implemented. SafeStream does not claim regulatory compliance or demonstrated effectiveness.

## Background

In August 2026, Brazil's National Data Protection Authority (ANPD) ordered a preventive suspension of Discord live-streaming functionality in Brazil. In November 2026, the ANPD's Board upheld that decision. This context motivates the project; **SafeStream is neither affiliated with nor endorsed by Discord or the ANPD**.

## Research question

How can live communication systems combine access controls, proportionate interventions and privacy-preserving signals to reduce serious risks without indiscriminate content monitoring?

## Initial goals

- Build a standalone, consent-based WebRTC research environment with synthetic accounts and safe test media.
- Evaluate room access controls, publishing/viewing authorization and session revocation.
- Prototype reporting, emergency-stop and escalation workflows.
- Measure response latency, authorization failures, false alarms, and metadata collection.
- Clearly report limitations and findings, including negative results.

## Not in scope for v0.1

Discord client modifications, platform restriction bypasses, real identity or age verification, real-world automated abuse recognition, collection of minors' data, or third-party private communications.

## Documents

- [Problem statement](docs/problem-statement.md)
- [Threat model](docs/threat-model.md)
- [Requirements](docs/requirements.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)

## Candidate stack (subject to architecture review)

React / TypeScript, Node.js / Fastify, WebRTC, PostgreSQL, Vitest, Playwright and Python for offline metrics.

## Research commitments

Safety by design; privacy and data minimization; evidence over marketing claims; reproducible synthetic tests; accessibility; and explicit separation of external facts from project hypotheses.

## Primary references

- [ANPD: preventive measure concerning Discord live streams (August 2026)](https://www.gov.br/anpd/pt-br/assuntos/noticias/em-medida-preventiva-anpd-determina-que-discord-suspenda-transmissoes-ao-vivo-no-brasil)
- [ANPD: Board upholds preventive measure (November 2026)](https://www.gov.br/anpd/pt-br/assuntos/noticias/conselho-diretor-da-anpd-rejeita-recurso-do-discord-e-mantem-interrupcao-das-transmissoes-ao-vivo-no-brasil)
- [AGU: federal court orders protective measures (September 2026)](https://www.gov.br/agu/pt-br/comunicacao/noticias/justica-acata-pedido-da-agu-e-determina-que-discord-adote-medidas-efetivas-de-protecao-a-criancas-e-adolescentes-1/)

This repository is not a legal opinion; any provider-specific obligations require review of the actual decisions and qualified legal advice.

## License

A license has not been selected yet; public visibility alone does not permit reuse or redistribution. Please discuss contributions via issues until licensing is resolved.
