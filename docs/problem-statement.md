# Problem Statement

**Status:** Working hypothesis, v0.1 — 2026-11-23

## Context and evidence

The Brazilian ANPD announced a preventive measure on 12 August 2026 to suspend live-streaming functionality on Discord after identifying serious concerns regarding protection of children and adolescents. On 19 November 2026, the ANPD announced that its Board rejected Discord's appeal and maintained the measure. Separately, Brazilian government reporting describes judicially ordered protective measures. These are distinct proceedings; this project does not infer that a prototype meets either one's requirements.

Sources: [ANPD August announcement](https://www.gov.br/anpd/pt-br/assuntos/noticias/em-medida-preventiva-anpd-determina-que-discord-suspenda-transmissoes-ao-vivo-no-brasil), [ANPD November announcement](https://www.gov.br/anpd/pt-br/assuntos/noticias/conselho-diretor-da-anpd-rejeita-recurso-do-discord-e-mantem-interrupcao-das-transmissoes-ao-vivo-no-brasil), [AGU reporting](https://www.gov.br/agu/pt-br/comunicacao/noticias/justica-acata-pedido-da-agu-e-determina-que-discord-adote-medidas-efetivas-de-protecao-a-criancas-e-adolescentes-1/).

## Engineering problem

Live video and screen sharing can expose participants to harmful interactions, unauthorized viewers, coercive social dynamics, and delayed intervention. Overly broad surveillance, however, can compromise privacy and produce inaccurate automated decisions. These design tensions require empirical evaluation, not a blanket assertion that either monitoring or access restriction solves the problem.

## Research question

Can a privacy-minimizing combination of access controls, rapid intervention and accountable reporting reduce measurable laboratory risks in live communication?

## Assumptions to test (not established facts)

1. Server-authorized membership can reduce access by unauthorized viewers.
2. Session revocation can reliably stop access within measurable time bounds.
3. Accessible reporting and emergency-stop flows can reduce time to intervention in simulated incidents.
4. Limiting retention and fields can improve privacy without disabling essential auditability.

## Stakeholders

Streamers; viewers; adolescents and guardians; moderators and trust-and-safety teams; platform operators; researchers; and privacy/regulatory stakeholders.

## Success criteria for the research

A reproducible reference implementation, an explicit threat model, tests of authorization and revocation, measured latency distributions, a data inventory, documented failures, and an independent limitations section. **Success is not defined as regulatory approval or elimination of all harm.**

## Ethical boundaries

No real abuse content, non-consensual recordings, genuine minors' information, undercover research or tests against Discord's production service. Use synthetic identities, actors who consent, and harmless scripted scenarios.
