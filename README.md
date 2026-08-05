# TrustGate

**A trustless task marketplace on Stellar.** Requesters post tasks and escrow payment,
executors bid with collateral, the marketplace picks a winner, and Soroban + escrow
settle the deal automatically — no middleman holding funds.

```
requester ──list task, pay fee──▶  marketplace  ◀──register, bid + collateral── executor
                                        │
                                  select winner
                                        │
                          escrow releases on completion
```

Built on **Soroban** (on-chain executor registry), **Trustless Work** (bid-collateral
escrow), **MPP**/**x402** (pay-per-result access), and the **Stellar SDK**.

## Table of contents

- [Stack](#stack)
- [Quick start](#quick-start-local-network)
- [Environment variables](#environment-variables)
- [Testing](#testing)
- [Docker](#docker-full-stack)
- [Testnet deployment](#running-against-real-stellar-testnet)
- [Signed requests (dApp)](#signed-requests-dapp)
- [API walkthrough](#example-full-lifecycle-via-curl)
- [Observability](#observability)
- [Known limitations](#known-limitations)

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+, TypeScript, Express |
| On-chain | Soroban `Registry` contract (executor allow-list), `@stellar/stellar-sdk` |
| Escrow | Trustless Work (bid collateral) |
| Pay-per-result | x402 (`@x402/*`) + MPP |
| Tests | Jest + Supertest (unit/integration/e2e) |
| Ops | pino (logs), prom-client (metrics), swagger-jsdoc/swagger-ui-express (API docs) |

## Quick start (local network)

```bash
npm install
docker compose up -d          # Stellar Quickstart (standalone network) + Redis
npm run deploy:registry       # deploys the Registry contract, writes REGISTRY_CONTRACT_ID to .env
npm run start:dev             # http://localhost:3000
```

That's it — `deploy:registry` also generates and Friendbot-funds a throwaway
`ADMIN_SECRET` if you don't have one yet. Want explicit control instead? Copy
`.env.example` to `.env` and fill in values before running the steps above.

Once it's up:

| Endpoint | What it's for |
|---|---|
| `GET /health` | Liveness check |
| `GET /health/detailed` | Real Stellar RPC + Redis connectivity check |
| `GET /metrics` | Prometheus metrics |
| `GET /api-docs` | Swagger UI — every endpoint documented and testable |

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
| `RESULT_PUBLISHED_WEBHOOK_URL` | | Optional webhook called when an executor publishes a result (`POST /executor/tasks/:taskId/result`). |
| `OZ_API_KEY` | | [OZ Channels](https://channels.openzeppelin.com/testnet/gen) key. Without it, `GET /executor/tasks/:taskId/result` (x402-gated) isn't mounted — the rest of the app still runs. |
| `X402_NETWORK` | | CAIP-2 network id for x402, e.g. `stellar:testnet`. |
| `X402_FACILITATOR_URL` | | OZ Channels facilitator URL. |
| `EXECUTOR_WALLET` | | Recipient for x402 result payments. Defaults to the marketplace wallet. |
| `EXECUTOR_RESULT_PRICE` | | Price for `GET /executor/tasks/:taskId/result`, e.g. `$0.05`. |
| `ACCOUNT_WASM_HASH` | | Only for `scripts/deploy-smart-account.ts` — see [Known limitations](#known-limitations). |
| `REQUESTER_SECRET` | | Only for `scripts/deploy-smart-account.ts`. |

Full list with inline comments in `.env.example`; a ready-made testnet config lives in
`.env.testnet` (see [testnet section](#running-against-real-stellar-testnet)).

### Webhook receiver (local)

For quick local testing, run a simple webhook receiver:

```bash
npm run webhook:receiver
```

Then point the app to it (for `start:dev` outside Docker):

```bash
RESULT_PUBLISHED_WEBHOOK_URL=http://localhost:4000/webhooks/result-published npm run start:dev
```

## Testing

```bash
npm test              # unit + integration (skips anything needing real external credentials)
npm run test:e2e      # full mocked lifecycle: register → publish → bid → select → pay → release
```

Tests that need real infrastructure (a live local Stellar Quickstart, a real Trustless
Work key, a real OZ Channels key) are gated with `describe.skip` and skip cleanly when
that infrastructure isn't present — they aren't flaky, they're honest about what they need.

## Docker (full stack)

```bash
docker compose up --build -d   # Stellar Quickstart + Redis + this app, wired together
curl http://localhost:3000/health
```

The `app` service waits for Stellar and Redis to be reachable (`scripts/wait-for-it.sh`)
before starting, reads secrets from `.env.docker` via `env_file`, and overrides the
network-specific URLs to point at the in-Compose-network hostnames.

For Docker, the compose file reads configuration from `.env.docker` (gitignored). You can
start from `.env.example` and copy the needed values over.

## Running against real Stellar testnet

```bash
npm run testnet:setup            # generates + Friendbot-funds admin/requester/executor accounts,
                                  # adds real Circle USDC trustlines, writes .env.testnet
npm run testnet:deploy-registry  # deploys the Registry contract to testnet
```

The one step that can't be scripted: fund the requester with real (fictitious) testnet
USDC via the [Circle faucet](https://faucet.circle.com) — it's a captcha-gated web form.
The setup script prints the exact address to paste in.

## Signed requests (dApp)

On testnet/pubnet, endpoints that mutate state never accept secret keys (S...). Instead,
the caller proves ownership of a Stellar account by signing a canonical payload and
sending it in request headers.

This project recommends server-issued one-time nonces via `POST /auth/nonce` and signing
via Stellar Wallets Kit.

### Install (React/Next.js)

```bash
npm i @creit.tech/stellar-wallets-kit @stellar/stellar-sdk
```

### Snippet

```ts
import { StellarWalletsKit, WalletNetwork, allowAllModules, FREIGHTER_ID } from '@creit.tech/stellar-wallets-kit';
import { Networks } from '@stellar/stellar-sdk';

const API_BASE_URL = 'http://localhost:3000';

const kit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET,
  selectedWalletId: FREIGHTER_ID,
  modules: allowAllModules(),
});

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function tgSignedFetch<TResponse>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  options: { idempotencyKey?: string } = {},
): Promise<TResponse> {
  const { address: publicKey } = await kit.getAddress();

  const nonceRes = await fetch(`${API_BASE_URL}/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  if (!nonceRes.ok) {
    throw new Error(`nonce failed: ${nonceRes.status}`);
  }
  const { timestamp, nonce } = (await nonceRes.json()) as { timestamp: number; nonce: string };

  const bodyText = JSON.stringify(body ?? {});
  const bodyHash = await sha256Hex(bodyText);

  const canonical = `${method}\n${path}\n${String(timestamp)}\n${nonce}\n${bodyHash}`;
  const { signedMessage } = await kit.signMessage(canonical, {
    address: publicKey,
    networkPassphrase: Networks.TESTNET,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tg-public-key': publicKey,
    'x-tg-timestamp': String(timestamp),
    'x-tg-nonce': nonce,
    'x-tg-signature': signedMessage,
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : bodyText,
  });
  if (!res.ok) {
    throw new Error(`request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TResponse;
}

async function exampleRegisterExecutor(): Promise<void> {
  await tgSignedFetch('POST', '/executors/register', { publicKey: 'G...', metadataUri: 'https://example.com/meta.json' }, {
    idempotencyKey: crypto.randomUUID(),
  });
}
```

Notes:

- The signed `path` must match the server route exactly and exclude query strings (for example, `/tasks/123/complete`).
- For endpoints that mutate state, `Idempotency-Key` is required.
- The request body hash is computed from the exact JSON string sent over the wire. Always use the same `bodyText` for hashing and `fetch`.
- If you want users to pick another wallet, initialize the kit with a different `*_ID` or use the kit's built-in modal and call `kit.setWallet(...)` before `getAddress()`.

### Freighter smoke test (local/Docker)

To validate Freighter signing against a running local stack, use the built-in smoke route:

Freighter quick checklist:

- Install the Freighter browser extension and create/import an account.
- Ensure Freighter is unlocked and the expected account is active.
- Allow the dApp's origin in Freighter (connect the site when prompted).
- If the kit's modal/button is used, confirm you selected Freighter and not another wallet.
- If you run the API via Docker, your dApp must call the host URL (for example `http://localhost:3000`), not the in-compose hostname.

1) Start Docker (local network + mocks recommended):

```bash
docker compose up --build -d
```

2) From your React app (Freighter via Stellar Wallets Kit), call:

- `POST /auth/nonce` to get `{ timestamp, nonce }`
- `POST /auth/signed-smoke` with the signature headers and a body like `{ publicKey: "...", hello: "world" }`

Copy/paste example (TypeScript):

```ts
import { StellarWalletsKit, WalletNetwork, allowAllModules, FREIGHTER_ID } from '@creit.tech/stellar-wallets-kit';
import { Networks } from '@stellar/stellar-sdk';

const API_BASE_URL = 'http://localhost:3000';

const kit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET,
  selectedWalletId: FREIGHTER_ID,
  modules: allowAllModules(),
});

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function validateSignedSmoke(): Promise<void> {
  const { address: publicKey } = await kit.getAddress();

  const nonceRes = await fetch(`${API_BASE_URL}/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  if (!nonceRes.ok) throw new Error(`nonce failed: ${nonceRes.status} ${await nonceRes.text()}`);
  const { timestamp, nonce } = (await nonceRes.json()) as { timestamp: number; nonce: string };

  const body = { publicKey, hello: 'world' };
  const bodyText = JSON.stringify(body);
  const bodyHash = await sha256Hex(bodyText);

  const canonical = `POST\n/auth/signed-smoke\n${String(timestamp)}\n${nonce}\n${bodyHash}`;
  const { signedMessage } = await kit.signMessage(canonical, {
    address: publicKey,
    networkPassphrase: Networks.TESTNET,
  });

  const res = await fetch(`${API_BASE_URL}/auth/signed-smoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tg-public-key': publicKey,
      'x-tg-timestamp': String(timestamp),
      'x-tg-nonce': nonce,
      'x-tg-signature': signedMessage,
    },
    body: bodyText,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`smoke failed: ${res.status} ${text}`);
  console.log('smoke ok:', text);
}
```

Expected response:

```json
{ "ok": true, "publicKey": "G..." }
```

### Troubleshooting (Freighter / signed requests)

- **401 `missing signature headers`**: ensure you are sending all headers: `x-tg-public-key`, `x-tg-timestamp`, `x-tg-nonce`, `x-tg-signature`.
- **401 `timestamp outside allowed window`**: call `POST /auth/nonce` immediately before the signed request and reuse the returned `timestamp`.
- **401 `invalid nonce`**: server nonces are one-time. Never reuse the same `{ nonce, timestamp }` for a second request; fetch a new nonce.
- **401 `public key mismatch for <field>`**: the body field (e.g. `publicKey` / `executorPublicKey`) must equal `x-tg-public-key`.
- **401 `invalid signature`**: confirm the canonical string is exactly:
  - `${METHOD}\\n${PATH}\\n${TIMESTAMP}\\n${NONCE}\\n${SHA256_HEX(bodyText)}`
  - `PATH` must exclude query string and match the route exactly (e.g. `/auth/signed-smoke`).
  - `bodyText` must be the exact JSON string you send in `fetch` (same spacing/order).
- **429 `rate limit exceeded`**: too many failed auth attempts (IP/public key). Wait a minute and retry, or fix the canonical/payload first.
- **CORS / preflight issues**: ensure the browser can send custom headers. If you deploy behind a proxy, verify CORS config allows `x-tg-*` headers.

## Example: full lifecycle via curl

```bash
# 1. Register an executor
curl -X POST localhost:3000/executors/register \
  -H 'Content-Type: application/json' \
  -d '{"secret":"S...(executor)","metadataUri":"https://executor.example.com/meta.json"}'

# 2. Requester publishes a task (pays a 0.5% USDC listing fee)
curl -X POST localhost:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"requester":"G...","secret":"S...(requester)","reservePrice":"10","description":"Summarize this PDF","deadline":"2026-12-31T00:00:00.000Z"}'

# 3. Executor bids, locking collateral in escrow
curl -X POST localhost:3000/bids \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"<id>","executor":"G...","secret":"S...(executor)","amount":"9","collateral":"1"}'

# 4. Admin selects the winning bid
curl -X POST localhost:3000/tasks/<id>/select -H 'x-admin-secret: <ADMIN_SECRET>'

# 5. Requester pays the executor's result endpoint via x402 (see src/services/x402PaymentService.ts)

# 6. Requester marks the task complete, releasing escrow
curl -X POST localhost:3000/tasks/<id>/complete \
  -H 'Content-Type: application/json' \
  -d '{"requester":"G...","secret":"S...(requester)"}'
```

Every request/response shape is documented interactively at `GET /api-docs`.

## Observability

Runbooks and metric-based troubleshooting live in [observability.md](file:///home/jistriane/TrustGate/TrustGate/docs/observability.md).

## Known limitations

A few integrations depend on external services we can't fully provision in an automated
environment. Each is wired with real, working client code — the limitation is credentials,
not implementation:

- **Trustless Work** (`EscrowService`) needs a real account/API key from
  [trustlesswork.com](https://blocks.trustlesswork.com).
- **OZ Channels** (x402 facilitator) needs a real key from
  [channels.openzeppelin.com](https://channels.openzeppelin.com/testnet/gen); without it,
  the x402-gated result endpoint is simply not mounted.
- **OpenZeppelin smart accounts** (`scripts/deploy-smart-account.ts`) need an
  already-deployed contract WASM — none ships in any published npm package for this
  feature, so `ACCOUNT_WASM_HASH` must come from building
  [github.com/kalepail/smart-account-kit](https://github.com/kalepail/smart-account-kit)'s
  Rust contract yourself.
- **Circle testnet USDC** requires the captcha-gated [faucet](https://faucet.circle.com) —
  see the [testnet section](#running-against-real-stellar-testnet).
