# ADR 0002: Estratégia on-chain — Registry Soroban Immutable + Escrow via SaaS de terceiro (Trustless Work)

## Status
- Aceito
- Data: 2026-08-05
- Implementação (2026-08-05 update): **5/6 pilares com fundação codada em src/ (P1.8A + P2.1 + P2.4 Opção C)**
  - ✅ Pausas off-chain de emergência: `PAUSE_NEW_TASKS`, `PAUSE_NEW_BIDS`, `PAUSE_WORKER_CONSUMPTION` (3 env vars parseadas em `src/config/safetyFeatures.ts`)
  - ✅ Allowlist/Denylist off-chain executores: `EXECUTOR_DENYLIST` (CSV Stellar G…, validado com regex `^G[A-Z2-7]{55}$`, aplicado em `BidController.create` + `TaskController.complete`)
  - ✅ Abstração `IProviderEscrow` + factory `createEscrowProvider()` + `ESCROW_IMPLEMENTATION=trustlesswork|mock|ourown` (antes tipo chamado `EscrowServiceLike`; mantemos alias deprecated para retrocompatibilidade). Factory valida 4 P0 blockers antes de retornar implementação `ourown`.
  - ✅ **Fundação** Chave pública de verificação webhook SaaS Escrow: `TRUSTLESS_WORK_WEBHOOK_PUBLIC_KEY` (parse em safetyFeatures, validação `len >= 32`, export via `SafetyFeatures.trustlessWorkWebhookPublicKey`, log no boot via `sha256[:8]` preview sem leak). Endpoint `POST /webhooks/trustless-work` + middleware de assinatura Ed25519/SPKI ainda **pendentes P2.2** (não há contrato de request do lado Trustless Work para desenhar middleware ainda).
  - ✅ **Contrato Escrow Nativo Opção C (Golden Path):** `contracts/escrow/Cargo.toml` + `src/lib.rs` (Soroban SDK 22.0.1, Rust 1.84, 4 métodos + 6 testes unitários). Métodos: `create_escrow` (CEI + executor.require_auth + save state + transfer USDC), `release_milestone` (release_signer.require_auth), `confiscate` (requester.require_auth + split_bp + requester/marketplace share), `claim_timeout` (permissionless após 14d ledger → 100% ao requester). **⚠️  P4 hoje: NÃO está ativável na produção agora.** 4 blockers P0 permanecem: (a) WASM compilado + deploy em testnet/pubnet (script `scripts/deploy-registry.ts` modelo existe); (b) 2 auditorias independentes publicadas (escrow = Top 5 surface de ataque DeFi); (c) TypeScript bindings gerados em `src/contracts/bindings/escrow/` (espelhando bindings de registry); (d) `OurOwnEscrowContractClientStub` substituído por implementação real que chama os bindings via Soroban RPC. Hoje a factory retorna um STUB SEGURO que lança erro em todos os 3 métodos (`createEscrow`/`releaseMilestone`/`confiscate`) com mensagem detalhada de blockers se ativado prematuramente.
  - ⏳ Leitura dual registry blue-green (v1 + v2 ao mesmo tempo por 7 dias): pendente até existir v2 para migrar

## Contexto
- O TrustGate interage com a blockchain Stellar (Soroban + Classic + MPP) em dois pontos centrais que requerem compromisso entre simplicidade, segurança e capacidade de evolução:
  1. **Registry de Executores** — contrato Soroban `RegistryContract` em [contracts/registry/src/lib.rs](file:///home/jistriane/TrustGate/TrustGate/contracts/registry/src/lib.rs) que armazena `(executor Address → ExecutorInfo { metadata_uri })` e expõe 3 funções: `register_executor`, `is_registered`, `get_executor`. Apenas o executor autentica via `require_auth()` no write; não há role de admin no contrato.
  2. **Colateral e milestones de escrow** (depósito por executor em bid, release por marketplace quando task completada, disputa, rollback de milestone). O TrustGate **NÃO** implementa o contrato de escrow on-chain — consome a API REST de [escrowService.ts](file:///home/jistriane/TrustGate/TrustGate/src/services/escrowService.ts) via `@stellar-agent-kit/plugin-trustless-work` (cliente de provedor SaaS).
- A implantação do Registry via [scripts/deploy-registry.ts](file:///home/jistriane/TrustGate/TrustGate/scripts/deploy-registry.ts) publica o WASM e retorna o `REGISTRY_CONTRACT_ID` como string. O script **não** implementa nenhuma função de upgrade (`update_current_contract_wasm`, `set_contract_instance_v2`, etc.) nem expõe nenhum método `upgrade(address executor)`.
- Opções arquiteturais consideradas dependem do trade-off:
  - **Upgradeable Registry:** menor tempo de deploy de patch on-chain, mas custo em gas por storage extra da função de upgrade + superfície de ataque maior (chave de admin de upgrade = alvo).
  - **Our-own Escrow Contract:** completo controle sobre pause/unpause, upgrade e fees de plataforma, mas auditoria externa obrigatória (várias semanas), implicação legal (somos custodiantes indiretos), e manutenção contínua de contrato em produção (rollbacks de bug on-chain custam caro em Stellar Soroban).

## Decisão
Adotar **duas estratégias separadas** (separation of concerns), cada uma alinhada ao risco do componente:

1. **Registry Soroban Immutable (Não-Upgradeable):**
   - Manter `RegistryContract` com 3 funções apenas e sem método de upgrade de WASM no contrato.
   - **Roadmap de deploy para evolução:** Blue-green via `REGISTRY_CONTRACT_ID` env var:
     1. Deploy do novo WASM (v2, v3, …) → novo contract address `C2`.
     2. Migrar (off-chain, pelo marketplace) executores ativos: `POST /executors/register` apontando para `C2` (cada executor autentica `require_auth()` individualmente no novo contrato — nenhum chave admin global executa migração forçada).
     3. Período de carência de ~7 dias (configurável por feature flag) onde o App lê de **ambos os contratos** (old + new) em `is_registered` check para não quebrar executores que ainda não re-registraram.
     4. Ao fim do período, `REGISTRY_CONTRACT_ID` trocado de `C1` → `C2`, leitura de `C1` desligada.
   - **TTL:** Instance TTL extend para `518_400` blocos (~30 dias em 5 s/bloco) após todo write; threshold `100`. Instance storage é barato no Soroban.
   - **Pattern:** "Non-upgradeable contract + data layer off-chain orchestration" (não precisamos de upgrade no código do contrato porque camada de migração é API off-chain).

2. **Escrow de bid/milestones via SaaS Trustless Work (terceiro):**
   - Manter [escrowService.ts](file:///home/jistriane/TrustGate/TrustGate/src/services/escrowService.ts) como wrapper REST sobre `@stellar-agent-kit/plugin-trustless-work`, com roles:
     - `serviceProvider` = nosso `MARKETPLACE_WALLET.publicKey`
     - `releaseSigner` = nosso `MARKETPLACE_WALLET.publicKey` (assinatura offline em chave guardada em Vault/secret env)
     - `approver` / `disputeResolver` = nosso `MARKETPLACE_WALLET.publicKey`
   - **Pause / Upgrade / Segurança de Contrato Escrow:** responsabilidade explicitamente do provedor SaaS Trustless Work. Nós documentamos a estratégia de dependência:
     - Compromisso contratual (SLA) com provedor cobrindo pause em caso de vulnerabilidade divulgada e canal de comunicação P0 (24/7).
     - Provedor nos entrega, a cada release do contrato escrow deles: (a) relatório de auditoria externa mais recente (2 auditorias independentes, mínimo), (b) changelog de break-changes nos endpoints `/bid` `/release` `/raiseDispute` com 30 dias de deprecation notice, (c) chave pública de verificação de respostas da API para validar assinatura em webhook de dispute resolvido.
   - **Estratégia de saída (Exit strategy) do provedor:** mantemos o `IProviderEscrow` interface (abstração no `EscrowService` com injectedClient) e temos blueprint para `OurOwnEscrowContractClient` como implementação de fallback — ativável por env var `ESCROW_IMPLEMENTATION=trustlesswork|ourown` sem reescrever regras de negócio em `bidController` / `taskController`.

3. **Nenhuma feature flag global de "pause on-chain" no TrustGate diretamente:** pausas de emergência (e.g., congelar novos bids / novas tasks) acontecem via:
   - `paused()` lógica do provedor SaaS Trustless Work para escrow;
   - `PAUSE_NEW_TASKS`, `PAUSE_NEW_BIDS`, `PAUSE_WORKER_CONSUMPTION` feature flags off-chain no App (3 env vars candidatas a implementar em incidente P0) que bloqueiam mutações sem afetar reads e sem exigir transação on-chain.

## Consequências
- Prós
  - **Registry:** menor custo de gas por deploy e por invocação (nenhuma verificação de `admin`/role de upgrade em write, nenhum storage extra para `current_wasm_hash`); aprovação mais rápida por auditores externos do contrato por mínima superfície de ataque (3 funções apenas).
  - **Registry:** nenhuma chave single-point-of-failure ("admin upgrade key") em segredo de deploy. Cada executor controla seu próprio re-registro via `require_auth()` = **non-custodial pattern**.
  - **Escrow SaaS:** zero esforço de auditoria própria de contrato on-chain; bug de contrato de escrow (vulnerabilidade de reentrancy / bad math) é responsabilidade do fornecedor com SLA.
  - **Escrow SaaS:** foco do nosso time nas regras de negócio do marketplace (tasks/bids/auction/webhooks/outbox) vs. detalhes de engenharia criptográfica de pagamento atômico.
  - **Pausas de emergência via feature flag off-chain:** deploy de mitigação em minutos, não horas; não exige coordenação multisig on-chain.
- Contras
  - **Registry:** rollout de breaking change no schema do Registry (ex.: adicionar campo `reputation_score` ou `capabilities` em `ExecutorInfo`) exige deploy de novo contrato + período de carência de 7 dias → ~1–2 semanas de overhead operacional por release de schema (não existe "hot upgrade").
  - **Registry:** executores inativos que não re-registram no novo contrato no período de carência somem do registry (trade-off aceitável pois marketplace pode notificar executores via e-mail/webhook).
  - **Escrow SaaS:** vendor lock-in parcial. Saída para outro fornecedor ou "nosso próprio contrato" exige reescrever a implementação do `IProviderEscrow` (esforço estimado ~8 SP). Webhook payloads e estado de escrow são do fornecedor; nossa cópia fica no Postgres via `bids.escrow_id` + outbox events para auditoria.
  - **Escrow SaaS:** bugs de contrato on-chain do fornecedor não tem patch rápido do nosso lado; temos que esperar release do fornecedor. Mitigação: SLA + pausa off-chain de novos bids via feature flag.
  - **Ambos:** Ausência de pause on-chain no Registry (uma vez que `executor.require_auth()` valida e grava, não há "unregister"). Mitigação: allowlist off-chain (`EXECUTOR_ALLOWLIST_DISABLE=false`) e `EXECUTOR_DENYLIST` env var de emergência (bloqueia `registerBid` e `POST /tasks/:id/complete` para chaves deny listadas sem exigir transação on-chain).

## Trade-offs operacionais adicionais (2026-08-05 update)

### Tabela de migração Registry blue-green (exemplo v1 → v2)

| Fase | Duração (ex.) | REGISTRY_CONTRACT_ID env | Leitura de executores | Re-registro |
|------|---------------|---------------------------|------------------------|-------------|
| 1 | Dia 0 | `C1` (antigo) | Só `C1` | Ninguém |
| 2 | Deploy `C2` + início carência (7 dias) | `C1` (ainda) | Leitura dual `C1 || C2` em `is_executor_registered` | Executores re-registram via API (UI marketplace botão "Update registry for v2") → cada um chama `require_auth()` no `C2` |
| 3 | Fim do período de carência (dia 7) | `C2` (novo) | Só `C2` | Encerrado. Executores que não migraram = removidos implicitamente do registry (podem reativar a qualquer momento re-registrando). |

O rollback desta migração é trivial: se `C2` apresentar comportamento inesperado em fase 2, voltar `REGISTRY_CONTRACT_ID` para `C1` (tempo ~1 min) e desligar dual read. Nenhuma transação on-chain é revertida.

### Tabela de obrigações contratuais com fornecedor SaaS Escrow (checklist mínimo)

| Item | Obrigatório? | Por quê |
|------|--------------|---------|
| 2 auditorias externas independentes publicadas para o contrato de escrow deles | ✅ Sim | Sem isso = P0 blocker de pubnet. |
| SLA 99,9% uptime + canal P0 24/7 para vulnerabilidades on-chain descobertas | ✅ Sim | Bug em escrow = perda de fundos de executor. |
| Chave pública de verificação de webhook (HMAC ou Ed25519) para validar chamadas de dispute resolvido | ✅ Sim | Previne webhook spoofed de "dispute won" a favor de executor fraudulento. |
| Deprecation notice 30 dias + changelog semântico em releases de API | ✅ Sim | Evita regressão silenciosa de integração. |
| Documentação de `pause/unpause` e seu SLO de ativação em produção | ✅ Sim | Plano de incidente P0 depende disso. |
| Provedor publica address do contrato de escrow e seu código fonte verified (Soroban verified WASM hash) | ✅ Sim | Transparência para nós auditarmos independentemente se a lib `plugin-trustless-work` chama o endereço esperado. |

### Saída do fornecedor (Exit strategy) — plano "15 dias sem vendor":

1. Desenvolver `OurOwnEscrowContractClient implements IProviderEscrow` (~8 SP) com contrato nosso (Soroban WASM) + deploy.
2. Migração de bids ativos: executores re-criam bids e colateral no novo contrato. Tasks com bid aceito mas não completado → opção `MIGRATE_ESCROW_TYPE` off-chain por task.
3. Trocar env var `ESCROW_IMPLEMENTATION=ourown` em deploy rolling.

## Alternativas consideradas
- **Registry Upgradeable via admin key + `update_current_contract_wasm`**
  - Rejeitado: menor tempo de patch, mas adiciona `admin` role = single point of failure. Em Stellar Soroban, "admin key" para um contrato de registry público é um alvo óbvio; a segurança de todo o marketplace dependeria do custodiente dessa chave (multisig on-chain ou KMS). A abordagem de blue-green via env var é menos elegante, mas mais segura para MVP pubnet.
- **Implementar nosso próprio contrato de Escrow (Soroban) ao invés de usar SaaS Trustless Work**
  - Rejeitado: custo proibitivo em esforço de auditoria (escrow = Top 5 atacável em DeFi) + responsabilidade fiduciária. Usamos SaaS Trustless Work (que já tem auditoria) para escrow, e mantemos interface `IProviderEscrow` para exit strategy. MVP primeiro, depois considerar próprio contrato quando volume justificar.
- **Pause on-chain (Pauseable extension) no próprio Registry**
  - Rejeitado: custo/complexidade por benefício baixo. Pausar *registrations* de executores não responde a nenhum incidente real do MVP; o vetor de ataque é executores maliciosos, que mitigamos com allowlist/denylist off-chain e validação de bids/tasks. Pausa de emergência em nível de marketplace é melhor tratada via feature flag off-chain + redeployment 1 min.
