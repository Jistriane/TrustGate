import { Keypair, contract } from '@stellar/stellar-sdk';
import { StellarConfig } from '../config/stellar';
import { USDC_DECIMALS } from '../config/usdc';
import { calculateListingFee } from './listingFee';
import { withRetry } from '../utils/retry';

export class InsufficientBalanceError extends Error {}
export class ChargeNetworkError extends Error {}

interface TokenContractMethods {
  transfer(args: {
    from: string;
    to: string;
    amount: bigint;
  }): Promise<contract.AssembledTransaction<null>>;
}

type TokenClient = contract.Client & TokenContractMethods;

export interface ChargeResult {
  feeAmount: number;
  txHash: string;
}

function isInsufficientBalanceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /balance|underflow|insufficient|trustline/i.test(message);
}

export interface MppChargeServiceLike {
  calculateFee(reservePrice: number): number;
  chargeListingFee(requester: Keypair, reservePrice: number): Promise<ChargeResult>;
}

/**
 * Charges the listing fee by taking the requester's own secret key and
 * executing the SAC transfer server-side. This is a `NETWORK=local` dev/CI
 * fallback only: `@stellar/mpp`'s Charge-mode SDK can't sign or verify
 * against a local standalone network's passphrase (it only knows
 * `stellar:testnet`/`stellar:pubnet`), so it can't be used here. On
 * testnet/pubnet, `POST /tasks` instead goes through the real MPP Charge
 * protocol gate (`src/config/mppCharge.ts`) — the requester signs the
 * transfer with their own key and this server never sees their secret.
 */
export class MppChargeService implements MppChargeServiceLike {
  constructor(
    private readonly config: StellarConfig,
    private readonly usdcSacContractId: string,
    private readonly marketplaceWallet: string,
  ) {}

  calculateFee(reservePrice: number): number {
    return calculateListingFee(reservePrice);
  }

  async chargeListingFee(requester: Keypair, reservePrice: number): Promise<ChargeResult> {
    const feeAmount = this.calculateFee(reservePrice);
    const amountUnits = BigInt(Math.round(feeAmount * 10 ** USDC_DECIMALS));

    return withRetry(async () => {
      const { signTransaction, signAuthEntry } = contract.basicNodeSigner(
        requester,
        this.config.networkPassphrase,
      );

      let client: TokenClient;
      try {
        client = (await contract.Client.from<TokenContractMethods>({
          contractId: this.usdcSacContractId,
          rpcUrl: this.config.rpcUrl,
          networkPassphrase: this.config.networkPassphrase,
          allowHttp: this.config.allowHttp,
          publicKey: requester.publicKey(),
          signTransaction,
          signAuthEntry,
        })) as TokenClient;
      } catch (err) {
        throw new ChargeNetworkError(
          `Failed to reach USDC contract at ${this.usdcSacContractId}: ${(err as Error).message}`,
        );
      }

      let tx;
      try {
        tx = await client.transfer({
          from: requester.publicKey(),
          to: this.marketplaceWallet,
          amount: amountUnits,
        });
      } catch (err) {
        if (isInsufficientBalanceError(err)) {
          throw new InsufficientBalanceError(
            `Requester ${requester.publicKey()} has insufficient USDC balance for listing fee of ${feeAmount}`,
          );
        }
        throw new ChargeNetworkError(`Failed to build listing fee transfer: ${(err as Error).message}`);
      }

      try {
        const sent = await tx.signAndSend({ force: true });
        return { feeAmount, txHash: sent.sendTransactionResponse?.hash ?? '' };
      } catch (err) {
        if (isInsufficientBalanceError(err)) {
          throw new InsufficientBalanceError(
            `Requester ${requester.publicKey()} has insufficient USDC balance for listing fee of ${feeAmount}`,
          );
        }
        throw new ChargeNetworkError(`Failed to submit listing fee transfer: ${(err as Error).message}`);
      }
    });
  }
}
