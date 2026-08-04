# ADR 0001: Outbox + Worker idempotente (Redis Streams) e conclusão assíncrona com Trustless Work

## Status
- Aceito
- Data: 2026-08-04

## Contexto
- O TrustGate executa ações externas (ex.: Trustless Work escrow, webhooks, pagamentos) que não podem ficar acopladas ao ciclo síncrono de request/response sem aumentar risco de timeouts, retries duplicados e inconsistências.
- Precisamos tolerar falhas transitórias (rede, dependências externas) e, ao mesmo tempo, garantir que efeitos de negócio sejam executados de forma controlada.
- O sistema já usa Postgres para persistência e Redis para fila/streams.

## Decisão
- Adotar o padrão **Outbox** no Postgres:
  - A API grava um registro em `outbox_events` como parte do fluxo de escrita principal.
  - Um publisher publica esses eventos em **Redis Streams** e marca `processed_at` no Postgres.
- Consumir Redis Streams via **consumer group** e processar eventos em um **Worker** separado do servidor HTTP.
- Garantia de entrega: **at-least-once**, com **idempotência por handler** persistida no Postgres:
  - Registrar consumo em `event_consumptions` com chave única `(handler_name, event_id)`.
  - Em reprocessamentos/duplicações, o handler retorna sem reexecutar efeitos.
- Mover efeitos externos sensíveis para o worker:
  - Em especial, o fluxo “`POST /tasks/:id/complete` → release do escrow (Trustless Work)” passa a ser assíncrono quando Outbox está habilitado:
    - API muda a task para `COMPLETING` e emite `task_completion_requested`.
    - Worker executa `releaseMilestone`, marca task `COMPLETED` e emite `task_completed`.
  - Sem Outbox (modo local/in-memory), manter fallback síncrono para facilitar dev e testes.

## Consequências
- Prós
  - Reduz risco de timeouts e duplicações causadas por retries do cliente.
  - Permite retries e backoff sem travar requests.
  - Mantém Postgres como fonte de verdade e trilha auditável de eventos/consumos.
- Contras
  - Introduz consistência eventual: alguns efeitos passam a ocorrer após a resposta HTTP.
  - Aumenta a superfície operacional (worker + redis streams).
  - Exige disciplina para handlers idempotentes e contratos de evento versionáveis.

## Alternativas consideradas
- Executar integrações externas no request/response (síncrono)
  - Rejeitado: alto risco de timeout, falhas de rede, e duplicação em retries.
- Redis-only (sem outbox no Postgres)
  - Rejeitado: maior risco de perda/indefinição de “fonte de verdade” e menor auditabilidade.
- Exactly-once estrito
  - Rejeitado: custo/complexidade maiores que o valor atual; at-least-once com idempotência atende o objetivo com menor risco.

