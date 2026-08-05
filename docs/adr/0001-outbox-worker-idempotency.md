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
  - Permite **observabilidade por backlog** (XLEN / XPENDING summary / XPENDING por consumer) diretamente via métricas Prometheus expostas em `/metrics` — diagnosticar consumer stuck ou backpressure não requer acesso `redis-cli`.
  - `XAUTOCLAIM` + métricas de per-consumer permitem detectar e recuperar automaticamente de workers mortos sem intervenção manual na grande maioria dos casos.
- Contras
  - Introduz consistência eventual: alguns efeitos passam a ocorrer após a resposta HTTP (ex.: `POST /tasks/:id/complete` retorna 202, release do escrow via Trustless Work é assíncrono).
  - Aumenta a superfície operacional (worker + redis streams). Requer **baseline de observabilidade** (signed smoke + métricas obrigatórias + regras Prometheus) antes de cada deploy conforme [docs/observability.md](file:///home/jistriane/TrustGate/TrustGate/docs/observability.md).
  - Exige disciplina para handlers idempotentes e contratos de evento versionáveis.
  - A métrica `tg_stream_pending_consumer{stream,group,consumer}` tem uma label a mais; **cardinalidade deve ser mantida baixa** (número fixo de consumers, tipicamente 1–16), e o worker zera explicitamente consumers que desaparecem após amostragem para evitar explosão de timeseries.

## Trade-offs operacionais adicionais (2026-08-05 update)

Para cada tick do worker, um caminho de **amostragem de backlog** executa a cada ~5 segundos (desacoplado do hot-path do tick para não adicionar latência em processamento de eventos):

| Amostragem | Onde lê | Métrica exposta | Por quê |
|-----------|---------|-----------------|---------|
| Stream size | Redis `XLEN` | `tg_stream_length{stream,group}` | Detecta produtor mais rápido que consumidores. |
| PEL summary | Redis `XPENDING` summary count | `tg_stream_pending{stream,group}` | Detecta entries entregues mas nunca `XACK`ed (handler lento / erro). |
| PEL por consumer | Redis `XPENDING` por consumer | `tg_stream_pending_consumer{stream,group,consumer}` | Detecta 1 worker específico travado / partitionado antes que `XAUTOCLAIM` colete. |
| Outbox unprocessed | Postgres `processed_at IS NULL` | `tg_outbox_unprocessed` | Detecta publisher (Postgres → Stream) parado. |
| Outbox failed | Postgres `attempts > 0 AND processed_at IS NULL` | `tg_outbox_failed` | Detecta publisher com falhas persistentes (emergência). |

Intervalo de amostragem (5 s) foi escolhido para não sobrecarregar Redis/Postgres em ticks de 2 s; para workloads com >1k events/s, é seguro subir o intervalo para 10–15 s via ajuste do sampling path (hardcoded hoje; candidato a `OUTBOX_BACKLOG_SAMPLE_MS` em iteração futura).

## Alternativas consideradas
- Executar integrações externas no request/response (síncrono)
  - Rejeitado: alto risco de timeout, falhas de rede, e duplicação em retries.
- Redis-only (sem outbox no Postgres)
  - Rejeitado: maior risco de perda/indefinição de “fonte de verdade” e menor auditabilidade.
- Exactly-once estrito
  - Rejeitado: custo/complexidade maiores que o valor atual; at-least-once com idempotência atende o objetivo com menor risco.

