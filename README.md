# TrustGate

A Stellar-native task marketplace: requesters list tasks and pay a USDC listing fee,
executors register on-chain and bid with escrowed collateral, the marketplace selects a
winner, and payment/escrow settle on completion. Built on Soroban, MPP (Machine Payments
Protocol), Trustless Work escrow, and the x402 payment protocol.

## Stack

- Node.js 20+, TypeScript, Express
- Soroban smart contract (Registry) — allow-list of executors
- `@stellar/stellar-sdk` for all Stellar/Soroban interaction
- Trustless Work for bid-collateral escrow
- x402 (`@x402/*`) for pay-per-result access to an executor's output
- Jest + Supertest for unit/integration/e2e tests
- pino (structured JSON logs) + prom-client (metrics) + swagger-jsdoc/swagger-ui-express (API docs)

## Quick start (local network)

```bash
npm install
docker compose up -d          # Stellar Quickstart (standalone network) + Redis
npm run deploy:registry       # deploys the Registry contract, writes REGISTRY_CONTRACT_ID to .env
npm run start:dev             # http://localhost:3000
```

`npm run deploy:registry` also auto-generates and Friendbot-funds a throwaway `ADMIN_SECRET`
if you don't already have one in `.env`. Copy `.env.example` to `.env` first if you want to
set values explicitly instead of relying on the defaults.

Once running:
- `GET /health` — liveness
- `GET /health/detailed` — real Stellar RPC + Redis connectivity check
- `GET /metrics` — Prometheus metrics
- `GET /api-docs` — Swagger UI, every endpoint documented and testable

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `NETWORK` | | `local` (default), `testnet`, or `pubnet` |
| `STELLAR_RPC_URL` | | Soroban RPC endpoint. Defaults to the local Quickstart. |
| `STELLAR_HORIZON_URL` | | Horizon endpoint. Defaults to the local Quickstart. |
| `REDIS_URL` | | Used only by `GET /health/detailed`'s connectivity check. |
| `ADMIN_SECRET` | | Marketplace admin's Stellar secret key (S...). Auto-generated + Friendbot-funded on `local` if unset. |
| `MARKETPLACE_WALLET` | | Public key that receives listing fees. Defaults to `ADMIN_SECRET`'s public key. |
| `USDC_ISSUER` | ✅ | Classic USDC asset issuer (G...) — the app derives the SAC contract ID from this + `NETWORK`. |
| `REGISTRY_CONTRACT_ID` | ✅ | Set by `npm run deploy:registry`. |
| `TRUSTLESS_WORK_API_KEY` | ✅ | [trustlesswork.com](https://blocks.trustlesswork.com) API key — required for bid escrow (`POST /bids`, `POST /tasks/:id/complete`). |
| `OZ_API_KEY` | | [OZ Channels](https://channels.openzeppelin.com/testnet/gen) key. Without it, `GET /executor/tasks/:taskId/result` (x402-gated) isn't mounted — the rest of the app still runs. |
| `X402_NETWORK` | | CAIP-2 network id for x402, e.g. `stellar:testnet`. |
| `X402_FACILITATOR_URL` | | OZ Channels facilitator URL. |
| `EXECUTOR_WALLET` | | Recipient for x402 result payments. Defaults to the marketplace wallet. |
| `EXECUTOR_RESULT_PRICE` | | Price for `GET /executor/tasks/:taskId/result`, e.g. `$0.05`. |
| `ACCOUNT_WASM_HASH` | | Only for `scripts/deploy-smart-account.ts` — see note below. |
| `REQUESTER_SECRET` | | Only for `scripts/deploy-smart-account.ts`. |

See `.env.example` for the full list with inline comments, and `.env.testnet` for a real
Stellar-testnet configuration (see below).

## Testing

```bash
npm test              # unit + integration (skips anything needing real external credentials)
npm run test:e2e       # full mocked lifecycle: register → publish → bid → select → pay → release
```

Integration tests that need real infrastructure (a live local Stellar Quickstart, a real
Trustless Work API key, a real OZ Channels key) are gated with `describe.skip` and skip
cleanly when that infrastructure isn't present — they aren't flaky, they're honest about
what they need.

## Docker (full stack)

```bash
docker compose up --build -d   # Stellar Quickstart + Redis + this app, wired together
curl http://localhost:3000/health
```

The `app` service waits for Stellar and Redis to be reachable (`scripts/wait-for-it.sh`)
before starting, and reads secrets from `.env` via `env_file` while overriding the
network-specific URLs to the in-Compose-network hostnames.

## Running against real Stellar testnet

```bash
npm run testnet:setup            # generates + Friendbot-funds admin/requester/executor accounts,
                                  # adds real Circle USDC trustlines, writes .env.testnet
npm run testnet:deploy-registry  # deploys the Registry contract to testnet
```

The one step that can't be scripted: fund the requester with real (fictitious) testnet
USDC via the [Circle faucet](https://faucet.circle.com) — it's a captcha-gated web form.
The setup script prints the exact address to paste in.

## Example: full lifecycle via curl

```bash
# 1. Register an executor
curl -X POST localhost:3000/executors/register \
  -H 'Content-Type: application/json' \
  -d '{"secret":"S...(executor)","metadataUri":"https://executor.example.com/meta.json"}'

# 2. Requester publishes a task (pays a 0.5% USDC listing fee)
curl -X POST localhost:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"requester":"G...","secret":"S...(requester)","reservePrice":10,"description":"Summarize this PDF","deadline":"2026-12-31T00:00:00.000Z"}'

# 3. Executor bids, locking collateral in escrow
curl -X POST localhost:3000/bids \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"<id>","executor":"G...","secret":"S...(executor)","amount":9,"collateral":1}'

# 4. Admin selects the winning bid
curl -X POST localhost:3000/tasks/<id>/select -H 'x-admin-secret: <ADMIN_SECRET>'

# 5. Requester pays the executor's result endpoint via x402 (see src/services/x402PaymentService.ts)

# 6. Requester marks the task complete, releasing escrow
curl -X POST localhost:3000/tasks/<id>/complete \
  -H 'Content-Type: application/json' \
  -d '{"requester":"G...","secret":"S...(requester)"}'
```

Every request/response shape is documented interactively at `GET /api-docs`.

## Known limitations

A few integrations depend on external services we can't fully provision in an automated
environment. Each is wired with real, working client code — the limitation is credentials,
not implementation:

- **Trustless Work** (`EscrowService`) needs a real account/API key from
  [trustlesswork.com](https://blocks.trustlesswork.com).
- **OZ Channels** (x402 facilitator) needs a real key from
  [channels.openzeppelin.com](https://channels.openzeppelin.com/testnet/gen); without it,
  the x402-gated result endpoint is simply not mounted.
- **OpenZeppelin smart accounts** (`scripts/deploy-smart-account.ts`, Sprint 17) need an
  already-deployed contract WASM — none ships in any published npm package for this
  feature, so `ACCOUNT_WASM_HASH` must come from building
  [github.com/kalepail/smart-account-kit](https://github.com/kalepail/smart-account-kit)'s
  Rust contract yourself.
- **Circle testnet USDC** requires the captcha-gated [faucet](https://faucet.circle.com) —
  see the testnet section above.
