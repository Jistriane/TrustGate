export class ExecutorNotAllowedError extends Error {}

export interface RegistryLookup {
  isRegistered(executorPublicKey: string): Promise<boolean>;
}

/**
 * Gates payments to an executor on the on-chain Registry allow-list.
 * Stands in for a real Soroban policy signer (Sprint 17) that isn't
 * deployable here — see SmartAccountService's notes — by enforcing the same
 * rule at the application layer, before a payment is ever signed.
 */
export class PolicyService {
  constructor(private readonly registry: RegistryLookup) {}

  async authorizeExecutorPayment(executorPublicKey: string): Promise<void> {
    const isRegistered = await this.registry.isRegistered(executorPublicKey);
    if (!isRegistered) {
      throw new ExecutorNotAllowedError(
        `Executor ${executorPublicKey} is not on the Registry allow-list`,
      );
    }
  }
}
