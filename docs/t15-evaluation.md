# T-15 — Incident Reporting & Audit Trail

## Avaliação técnica do laboratório

Data: 2026-11-27
Projeto: SafeStream
Escopo: M3 Response MVP
Ambiente: laboratório local, dados sintéticos

## 1. Objetivo

Implementar um fluxo mínimo de denúncias, triagem,
resolução e auditoria, preservando a separação entre
permissões das salas e registros de ocorrências.

## 2. Funcionalidades implementadas

- Submissão autenticada de denúncias por membros.
- Consulta de protocolo pelo próprio denunciante.
- Categorias controladas, sem texto livre ou mídia.
- Fila administrativa com paginação.
- Credencial de moderação independente da sessão comum.
- Transições submitted, triaged e resolved.
- Histórico de eventos com ator e horário.
- Persistência opcional em arquivo separado.
- Retenção experimental de sete dias.
- Idempotência opcional com chave aleatória.
- Preservação das denúncias após Emergency Stop.

## 3. Evidências de validação

Suíte local: 56 testes aprovados, zero falhas.

Foram exercitados:

- Autenticação e isolamento de acesso.
- Rejeição de identidade forjada.
- Operações administrativas autorizadas e negadas.
- Persistência e recuperação após reinicialização.
- Falhas simuladas de gravação.
- Rejeição de arquivos de estado inválidos.
- Expiração de registros na inicialização.
- Requisições repetidas com chave de idempotência.
- Incidente completo com participantes fictícios.
- Compatibilidade com os testes anteriores do T-14.

A aprovação local não substitui a validação no CI.

## 4. Limitações conhecidas

### Uso experimental

A implementação não é adequada para receber denúncias
reais ou armazenar material sensível.

### Persistência

O armazenamento persistente é opcional e depende de
SAFESTREAM_REPORT_STATE_FILE.

Quando habilitada, SAFESTREAM_STATE_FILE tambem e obrigatoria
para recuperar as identidades dos denunciantes apos reinicio.

Sem essa configuração, os registros permanecem apenas
na memória do processo.

A gravação em JSON não oferece transações multi-instância,
bloqueio entre processos ou garantia completa diante de
quedas de energia.

### Moderação

O laboratório utiliza uma credencial administrativa única.
Ela não proporciona atribuição individual confiável quando
compartilhada entre operadores.

A credencial deve ser gerada criptograficamente e nunca
incluída no repositório.

### Auditoria

O evento inicial de auditoria inclui um identificador
pseudonimo do denunciante, visivel aos moderadores.

O histórico é validado estruturalmente, mas não é
criptograficamente inviolável.

Um operador com controle do armazenamento pode alterar
ou substituir arquivos.

### Privacidade e retenção

Metadados pseudônimos permanecem no arquivo durante
o período de retenção.

Não há criptografia de dados em repouso.

A limpeza ocorre na inicialização e durante operações,
não por um agendador contínuo.

A remoção lógica não garante eliminação de backups,
réplicas ou blocos físicos do armazenamento.

### Resistência a abuso

Há limite global de relatórios, mas não há limitação
individual de frequência.

Um participante malicioso pode consumir a capacidade
disponível, causando negação de serviço para denúncias
legítimas.

### Idempotência

A deduplicação exige uma Idempotency-Key válida.
Requisições sem chave podem gerar registros separados.

A chave não permite criar ou recuperar denúncias em uma
sala encerrada. Sua validade acompanha o relatório.

## 5. Próximas melhorias

- Limitação de frequência por participante.
- Identidades individuais para moderadores.
- Armazenamento transacional adequado a múltiplas instâncias.
- Proteção de metadados em repouso.
- Política de retenção, limpeza e backup operacional.
- Monitoramento de capacidade e falhas.
- Avaliação de segurança independente.
- Medição reproduzível de latência de submissão e triagem.
- Regressão: Emergency Stop durante leitura do corpo HTTP.

## 6. Conclusão

O T-15 demonstrou funcionalmente o fluxo de denúncias
e auditoria em um ambiente controlado, com dados fictícios.

Os testes locais não demonstram segurança de produção,
resistência a adulteração ou proteção integral dos dados.

O resultado é apropriado como prova de conceito
experimental, sujeito à revisão de código e de segurança.
