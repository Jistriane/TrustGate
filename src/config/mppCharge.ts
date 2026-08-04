import type { RequestHandler } from 'express';
import { StellarConfig } from './stellar';

export type MppNetworkId = 'stellar:testnet' | 'stellar:pubnet';

/** @stellar/mpp only knows these two CAIP-2 ids; `local` has no equivalent. */
export function toMppNetworkId(network: StellarConfig['network']): MppNetworkId {
  return network === 'pubnet' ? 'stellar:pubnet' : 'stellar:testnet';
}

interface ChargeMethodParams {
  recipient: string;
  currency: string;
  network: MppNetworkId;
  rpcUrl: string;
  store: unknown;
}

interface MppxChargeOptions {
  amount: string;
  description?: string;
}

interface MppxInstance {
  stellar: { charge(options: MppxChargeOptions): RequestHandler };
}

interface MppxExpressModule {
  Mppx: { create(config: { methods: unknown[]; secretKey: string }): MppxInstance };
}

interface MppxServerModule {
  Store: { memory(): unknown };
}

interface StellarMppChargeServerModule {
  charge(params: ChargeMethodParams): unknown;
}

// `mppx` and `@stellar/mpp` ship pure ESM with no "require" export condition
// (same constraint as `@stellar-agent-kit/plugin-trustless-work` in
// escrowService.ts), so TypeScript's CJS-targeted static `import` would
// downlevel to a `require()` that throws `ERR_REQUIRE_ESM` at runtime. The
// indirect call via `Function` hides these from that rewrite so Node
// resolves them as genuine dynamic ESM imports.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

async function loadMppxExpress(): Promise<MppxExpressModule> {
  return (await dynamicImport('mppx/express')) as MppxExpressModule;
}

async function loadMppxServer(): Promise<MppxServerModule> {
  return (await dynamicImport('mppx/server')) as MppxServerModule;
}

async function loadStellarChargeServer(): Promise<StellarMppChargeServerModule> {
  return (await dynamicImport('@stellar/mpp/charge/server')) as StellarMppChargeServerModule;
}

export interface ListingFeeGateOptions {
  stellarConfig: StellarConfig;
  usdcSacContractId: string;
  marketplaceWallet: string;
  mppSecretKey: string;
}

/**
 * Builds the real MPP Charge-mode gate for `POST /tasks`'s listing fee.
 *
 * On a request with no payment credential, the returned handler responds
 * `402` with a signed challenge; the client signs the SAC transfer's auth
 * entry with its own key and resubmits with the credential header; only
 * then does this handler call `next()`. The requester's secret key never
 * reaches this server — contrast with `MppChargeService`, the `NETWORK=local`
 * dev/CI fallback that takes the secret directly and signs server-side
 * (necessary there because `@stellar/mpp` can't verify a local standalone
 * network's signatures — its passphrase table only covers testnet/pubnet).
 *
 * The fee amount is per-request (0.5% of the task's reserve price), so the
 * `charge` intent is registered once (lazily, on first call) but the actual
 * Express handler is built fresh per request with that request's amount.
 */
export function createListingFeeGateFactory(
  options: ListingFeeGateOptions,
): (amount: string, description: string) => Promise<RequestHandler> {
  let mppxPromise: Promise<MppxInstance> | undefined;

  async function getMppx(): Promise<MppxInstance> {
    if (!mppxPromise) {
      mppxPromise = (async () => {
        const [{ Mppx }, { Store }, { charge }] = await Promise.all([
          loadMppxExpress(),
          loadMppxServer(),
          loadStellarChargeServer(),
        ]);

        return Mppx.create({
          methods: [
            charge({
              recipient: options.marketplaceWallet,
              currency: options.usdcSacContractId,
              network: toMppNetworkId(options.stellarConfig.network),
              rpcUrl: options.stellarConfig.rpcUrl,
              // Single-instance replay-protection store. A multi-instance
              // deployment (e.g. several pods behind a load balancer) needs a
              // shared atomic store instead (see mppx's Store.redis(...)), or
              // a confirmed payment could be double-spent across instances.
              store: Store.memory(),
            }),
          ],
          secretKey: options.mppSecretKey,
        });
      })();
    }
    return mppxPromise;
  }

  return async (amount: string, description: string): Promise<RequestHandler> => {
    const mppx = await getMppx();
    return mppx.stellar.charge({ amount, description });
  };
}
