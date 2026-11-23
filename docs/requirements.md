# Requirements and Acceptance Criteria

**Version:** 0.1 proposed laboratory requirements. **These are project-designed engineering requirements, not a verified reproduction of legally binding ANPD requirements.** External constraints require separate legal mapping.

## Functional requirements

| ID | Requirement | Acceptance test |
|---|---|---|
| FR-01 | Only authenticated, authorized members may join a test room | Unauthorized join requests fail server-side |
| FR-02 | Publishing requires explicit server-approved role | Viewer cannot publish via direct API calls |
| FR-03 | Room owner or authorized moderator may revoke participation | Revoked user loses signaling and media access; timing recorded |
| FR-04 | Participants can stop sharing immediately | Stop action terminates local media tracks and session publication |
| FR-05 | Participants can submit an in-session safety report | Valid report enters triage queue with unique ID |
| FR-06 | Reports can be assigned, resolved and audited by authorized test moderators | State transitions require correct permissions |
| FR-07 | Test fixture supports simulated policy states without claiming identity verification | UI clearly labels fixture values as synthetic |

## Non-functional requirements

| ID | Requirement | Acceptance test |
|---|---|---|
| NFR-01 | No raw stream media persisted by default | Storage and traffic instrumentation confirm no server-side recordings |
| NFR-02 | Sensitive endpoints enforce authorization on backend | Automated negative/permission tests |
| NFR-03 | Event records have documented schema and retention | Inventory lists fields, purposes, deletion policy |
| NFR-04 | Revocation and report flows expose latency metrics | Tests publish p50/p95 and failures with sample sizes |
| NFR-05 | All research tests are safe and reproducible | Scripts use synthetic participants/media; instructions published |
| NFR-06 | Failures and uncertainty are documented | Report includes limitations and failed experiments |
| NFR-07 | Security controls do not depend solely on client-side UI | API tests bypass UI and still reject forbidden actions |

## Measurement protocol

Record test environment, workload, sample size, method, units, error cases, version and confidence intervals where appropriate. Do not set performance targets without a baseline and stakeholder-defined risk tolerance. A target introduced later must be identified as an engineering target, not proof of real-world safety.

## Regulatory traceability (research work item)

| Topic for review | Starting source | Current state |
|---|---|---|
| Preventive suspension and child-safety concerns | [ANPD August communication](https://www.gov.br/anpd/pt-br/assuntos/noticias/em-medida-preventiva-anpd-determina-que-discord-suspenda-transmissoes-ao-vivo-no-brasil) | Background identified; binding text not yet mapped |
| Appeal outcome and criteria for resumption | [ANPD November communication](https://www.gov.br/anpd/pt-br/assuntos/noticias/conselho-diretor-da-anpd-rejeita-recurso-do-discord-e-mantem-interrupcao-das-transmissoes-ao-vivo-no-brasil) | Background identified; binding text not yet mapped |
| Judicially ordered measures | [AGU communication](https://www.gov.br/agu/pt-br/comunicacao/noticias/justica-acata-pedido-da-agu-e-determina-que-discord-adote-medidas-efetivas-de-protecao-a-criancas-e-adolescentes-1/) | Separate proceedings; not a claim of coverage |

## Exclusions

No production safety guarantee, actual proof-of-age integration, real-world incident classifier, or Discord interoperability is required for v0.1.
