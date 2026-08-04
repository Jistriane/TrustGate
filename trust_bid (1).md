## TrustGate — Architecture

## Overview

TrustGate is a task marketplace built on Stellar, enabling requester-executor collaboration with on-chain payments, escrowed collateral, and automated auction resolution. It integrates multiple payment protocols (x402, MPP Charge) and uses Soroban smart contracts for on-chain state.

## High-Level Architecture

## Tech Stack


| Layer | Technology |
| --- | --- |
| Runtime | Node.js = 20, TypeScript (E52022, Common]S) |
| HTTP Framework Express 5 |   |
| Smart Contracts | Soroban (Rust) — contracts/registry |
| Payment Protocols | x402 (OZ Channels), MPP Charge (@stellar/mpp) |
| Escrow | Trustless Work escrow-as-a-service |
| Blockchain | Stellar (local / testnet / pubnet via stellar-sdk) |
| Cache Redis 7 |   |
| Observability | Pino (logging), prom-client (metrics), Swagger (OpenAPI) |
| Infrastructure | Docker Compose (stellar-quickstart, Redis, app) |
| Tooling | Caatinga CLI (contract build/deploy), Jest (testing) |

## Project Structure

```
trustgate/
|— contracts/
| L— registry/ Soroban smart contract (Rust)
| L— src/lib.rs H* Executor allow-list registry
|— src/
|— server.ts Entrypoint: boot, fund admin, start listening
app.ts Express app factory, route mounting, DI wiring
config/ Configuration & external client factories
| |— stellar.ts Stellarconfig (network, RPC, Horizon, passphrase)
| usdc.ts USDC asset + SAC contract ID derivation
| x402.ts Xx402 payment middleware gate (0Z Channels)
| |— mppcharge.ts MPP Charge gate factory (testnet/pubnet)
| |— smartAccount.ts 0Z Smart Account policy params
| logger.ts Pino logger config
| |— metrics.ts prom-client registry
| L— swagger.ts EEE OpenAPI/Swagger HTTP request handlers spec
|— controllers/
| |— taskcontroller.ts
| |— bidcontroller.ts
| |— executorcontroller.ts
| L— executorResultController.ts
i services/ |— auctionservice.ts
# Business
logic
# Lowest-bidder-wins
auction
| |— escrowservice.ts # Trustless Work escrow create/release/confisca
| |— mppchargeservice.ts # Listing fee charge (local dev fallback)
| registryservice.ts # on-chain executor registration (Soroban)
```


## Domain Model

## Task Lifecycle


## Bid Lifecycle

## Key Entities

| Entity | Fields |
| --- | --- |
| Task | id, requester (G...), reservePrice, description, deadline, status |
|   | id, taskid, executor (G...), amount , collateral, escrowId, status, |
| Bid I |   |
| createdAt |   |
| Executor | publickey (G...), metadatauri (on-chain) |

## Payment Protocols

## 1. Listing Fee (MPP Charge) — POST /tasks

- \* Rate: 0.5% of the task's reserveprice in USDC

- \* Local network: Mppchargeservice takes the requester's secret directly and signs server-side (dev/CI only)

- \* Testnet/Pubnet: Real MPP Charge protocol gate ( createListingFeeGateFactory ) —


server returns 4e2 with a signed challenge; client signs the SAC autn entry with its own key and resubmits. The secret never reaches the server.

## 2. Collateral Escrow — POST /bids

- \* Executors lock USDC collateral via Trustless Work escrow-as-a-service

- \* Single-release escrow with marketplace wallet as approver + release signer

- \* Release: On task completion, EscrowService.releaseMilestone() sends funds to the executor

- \* Conf Bcate: On timeout, Escrowservice.confiscate() raises a dispute splitting funds (70% requester / 30% marketplace)

## 3. x402 Paid API — GET /executor/tasks/:taskId/result

- \* Gated behind OpenZeppelin Channels x402 payment middleware

- \* Client must pay \$0.05 USDC to receive the task result

- \* Uses Exactstellarscheme with the OZ Channels facilitator

## Smart Contracts

## Registry Contract (contracts/registry)

Soroban contract (Rust, #![no_std] ) serving as an on-chain allow-list for executors.

| Method | Description |
| --- | --- |
| register_executor | Register an executor with metadata URI (requires auth) |
| is_registered | Check if an executor is registered |
| get_executor | Get executor metadata (errors if not found) |

Storage: persistent Datakey::Executor (Address) — ExecutorInfo { metadata uri }

## Infrastructure

## Docker Compose Services

| Service | Image | Purpose |
| --- | --- | --- |
| stellar- | stellar/quickstart: latest | Local Stellar node (Soroban |
|   |   | RPC |


| redis:7-alpine | Cache (not exposed to host) |
| --- | --- |
| Custom build (Dockerf le) | TrustGate API server |

## Environment Conf guration

Key env vars (see .env.example ):

| Variable | Purpose |
| --- | --- |
| NETWORK | local / testnet / pubnet |
| STELLAR_RPC _URL | Soroban RPC endpoint |
| ADMIN_SECRE T | Marketplace admin keypair |
| REGISTRY_CO NTRACT_ID | Deployed registry contract address |
| USDC_ISSUER | USDC asset issuer public key |
| MPP_SECRET_| KEY | HMAC key for MPP Charge challenges |
| TRUSTLESS_W( ORK_API_KEY | Trustless Work API key for escrows |
| 0Z_API_KEY | OpenZeppelin Channels API key (x402) |
| REDIS_URL | Redis connection string |

## API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /health |   | Liveness check |
|   |   |   | Dependency health |
| GET | /health/detailed |   |   |
|   |   |   | (Stellar RPC, Redis) |
| GET | /metrics |   | Prometheus metrics |
|   |   |   | Register executor on- |
| POST | /executors/register |   |   |
|   |   |   | chain |
|   |   |   | Create task (listing fee |
| POST /tasks |   | MPP/402 |   |
|   |   |   | required) |
| POST | /tasks/:id/select | Admin | Select winning bid |
|   |   |   | Comnlete task release |


| POST | /tasks/:id/complete | Requester |
| --- | --- | --- |
|   |   | escrow |
|   |   | Submit bid (collateral |
| POST | /bids |   |
|   |   | escrowed) |
|   |   | Manual expired-task |
| POST | /admin/timeout-check | Admin |
|   |   | sweep |
| GET | /executor/tasks/:taskId/result | Fetch task result (paid) x402 |
| GET | /feed/stream | SSE stream of new tasks |
| GET | /api-docs | Swagger UI |

## Testing

- \* Unit tests: Jest + ts-jest ( npm test)

- \* E2E tests: npm run test:e2e (uses Appoverrides for mocked services)

- \* Contract tests: test in contracts/registry cargo

- \* Test snanshots: contracts/reaistrv/test snanshots/
