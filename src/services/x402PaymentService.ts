import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { PolicyService } from './policyService';

type FetchWithPayment = (url: string) => Promise<Response>;

export interface X402PaymentServiceOptions {
  network?: string;
  policyService?: PolicyService;
  fetchWithPayment?: FetchWithPayment;
}

/**
 * Pays for an executor's task result via the x402 protocol: negotiates the
 * 402 challenge, signs a Soroban payment with the requester's key, retries
 * with the payment header attached, and returns the delivered result.
 */
export class X402PaymentService {
  private readonly network: string;
  private readonly policyService?: PolicyService;
  private readonly injectedFetchWithPayment?: FetchWithPayment;

  constructor(
    private readonly requesterSecret: string,
    options: X402PaymentServiceOptions = {},
  ) {
    this.network = options.network ?? 'stellar:testnet';
    this.policyService = options.policyService;
    this.injectedFetchWithPayment = options.fetchWithPayment;
  }

  private buildFetchWithPayment(): FetchWithPayment {
    if (this.injectedFetchWithPayment) {
      return this.injectedFetchWithPayment;
    }

    const signer = createEd25519Signer(this.requesterSecret, this.network as never);
    return wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: this.network as never, client: new ExactStellarScheme(signer) }],
    });
  }

  async payForResult(
    taskId: string,
    executorEndpoint: string,
    executorPublicKey?: string,
  ): Promise<unknown> {
    if (this.policyService && executorPublicKey) {
      await this.policyService.authorizeExecutorPayment(executorPublicKey);
    }

    const fetchWithPayment = this.buildFetchWithPayment();
    const url = `${executorEndpoint.replace(/\/$/, '')}/executor/tasks/${taskId}/result`;

    const response = await fetchWithPayment(url);
    if (!response.ok) {
      throw new Error(`Payment for task result failed: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }
}
