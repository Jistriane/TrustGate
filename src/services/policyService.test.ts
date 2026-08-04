import { ExecutorNotAllowedError, PolicyService } from './policyService';

describe('PolicyService.authorizeExecutorPayment', () => {
  const executorPublicKey = 'GBEXECUTOR000000000000000000000000000000000000000000000';

  it('resolves when the executor is registered', async () => {
    const registry = { isRegistered: jest.fn().mockResolvedValue(true) };
    const policyService = new PolicyService(registry);

    await expect(policyService.authorizeExecutorPayment(executorPublicKey)).resolves.toBeUndefined();
    expect(registry.isRegistered).toHaveBeenCalledWith(executorPublicKey);
  });

  it('throws ExecutorNotAllowedError when the executor is not registered', async () => {
    const registry = { isRegistered: jest.fn().mockResolvedValue(false) };
    const policyService = new PolicyService(registry);

    await expect(policyService.authorizeExecutorPayment(executorPublicKey)).rejects.toBeInstanceOf(
      ExecutorNotAllowedError,
    );
  });
});
