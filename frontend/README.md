# TrustGate — frontend

A single-page client for the TrustGate API. One button runs a **full task lifecycle
end to end** against a live backend and streams every stage to the screen, so the
protocol can be demonstrated without curl or a wallet.

See the [recorded demo](../docs/media/trustgate-demo.mp4) for what a run looks like.

## What a run does

Pressing **Start run** generates two throwaway Stellar keypairs in the browser and
walks the six stages of a job, calling the real API at each step:

| # | Stage | Actor | API call |
|---|-------|-------|----------|
| 1 | Register executor | Executor | `POST /executors/register` |
| 2 | Create task | Requester | `POST /tasks` |
| 3 | Bid and lock collateral | Executor | `POST /bids` |
| 4 | Automatic assignment | Protocol | (no call — the first valid bid at or under reserve wins) |
| 5 | Publish result | Executor | `POST /executor/tasks/:id/result` |
| 6 | Approve and settle | Requester | `POST /tasks/:id/complete`, then polls `GET /tasks/:id` |

Settlement is asynchronous on the backend (the worker releases the escrow), so step 6
polls the task every 2s for up to 90s until it reads `COMPLETED` or `EXPIRED`.

The run uses fixed terms so the numbers on screen are readable in advance: **$10**
reserve, **$9** bid, **$10** collateral, **0.5%** listing fee.

Alongside the stage timeline the UI shows the task state machine
(`OPEN → ASSIGNED → COMPLETING → COMPLETED`), the two generated addresses, the terms,
an activity log of the last 60 events, and a final panel with the task ID and the
SHA-256 payload hash.

## Quick start

The backend has to be reachable, otherwise the header reads "API unreachable" and a run
fails partway through. From the repository root, bring up the API first (see the
[root README](../README.md#quick-start-local-network)), then:

```bash
npm install
npm run dev          # http://localhost:5173
```

In development no `VITE_API_URL` is needed: the Vite dev server proxies `/health`,
`/auth`, `/executors`, `/tasks`, `/bids`, `/executor`, `/admin`, `/feed` and `/metrics`
to `http://localhost:3000`.

| Script | Does |
|--------|------|
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | `tsc -b` then `vite build` |
| `npm run preview` | Serves the production build |
| `npm run lint` | oxlint (react + typescript + oxc plugins) |

## Configuration

Copy `.env.example` to `.env.local`:

| Variable | Default | Meaning |
|----------|---------|---------|
| `VITE_API_URL` | *empty* | Backend base URL. Empty uses the dev-server proxy; set it for a deployed build. |
| `VITE_NETWORK` | `local` | `local` \| `testnet` \| `pubnet`. Shown in the header badge and decides how requests are authenticated. |

### `VITE_NETWORK` changes how requests are authenticated

- **`local`** — no signature auth. Secret keys are sent **in the request body** so the
  backend can sign on the client's behalf. Convenient for dev and CI, and unacceptable
  anywhere else.
- **`testnet` / `pubnet`** — secret keys never leave the browser. Each state-mutating
  call fetches a one-time nonce from `POST /auth/nonce`, signs
  `METHOD\npath\ntimestamp\nnonce\nsha256(body)` with Ed25519, and sends
  `x-tg-public-key`, `x-tg-timestamp`, `x-tg-nonce` and `x-tg-signature`. Every mutating
  call also carries an `Idempotency-Key`.

Both paths live in `signedRequest()` in [`src/api.ts`](src/api.ts).

### About the generated keypairs

Keys are created per run with `Keypair.random()` and only exist in that browser tab. The
result panel prints them, including the secret keys, on purpose — the run is meant to be
inspectable. They hold no balance; never fund them or reuse them. The demo video blurs
those two rows before recording.

## Layout

```
src/
  main.tsx              React root
  App.tsx               re-exports Home
  api.ts                API client — plain and signed request paths
  types.ts              Task, Bid, LogEntry, NonceResponse
  index.css             design tokens (oklch), reset, a11y helpers
  components/
    Home.tsx            shell: brand, network badge, health probe
    TaskFlow.tsx        the run itself — stages, state, log, result
    icons.tsx           inline SVG icons
```

## Accessibility

Worth preserving when editing: the run section carries `aria-busy`, the progress bar has
a real `role="progressbar"` with `aria-valuenow`, and the activity log is an
`aria-live="polite"` region. Stage status is conveyed by colour and shape, so each stage
also carries an `.sr-only` sentence stating it in words.

Under `prefers-reduced-motion: reduce`, `src/index.css` flattens animations globally
except for elements marked `data-motion="essential"` — the two spinners, which instead
downgrade to a slow pulse. Removing that attribute would leave a running operation with
no visible indication that it is running.

## Current limitations

- **No wallet connection.** Runs sign with keypairs generated in the browser, so there
  is nothing to connect. Wiring up Freighter (via `@creit.tech/stellar-wallets-kit`, or
  the Wallet Standard) is the natural next step and would make `local` mode unnecessary.
- **One hardcoded scenario.** Terms, the task description and the result payload are
  constants in `TaskFlow.tsx`. There is no form to post a real task, no task list, and no
  way to act as only one of the two parties.
- **`api.ts` is ahead of the UI.** `getHealthDetailed`, `getNonce`, `selectBid` and
  `getResult` are implemented but unused — `selectBid` in particular covers the
  admin-driven selection path that the automatic assignment flow replaced.
