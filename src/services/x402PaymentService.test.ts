import { Keypair } from '@stellar/stellar-sdk';
import { X402PaymentService } from './x402PaymentService';
import { ExecutorNotAllowedError, PolicyService } from './policyService';

describe('X402PaymentService.payForResult', () => {
  const requester = Keypair.random();

  it('calls the executor result endpoint and returns the parsed result', async () => {
    const fakeFetchWithPayment = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ taskId: 'task-1', resultHash: 'sha256:abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const service = new X402PaymentService(requester.secret(), {
      network: 'stellar:testnet',
      fetchWithPayment: fakeFetchWithPayment,
    });

    const result = await service.payForResult('task-1', 'https://executor.example.com');

    expect(fakeFetchWithPayment).toHaveBeenCalledWith(
      'https://executor.example.com/executor/tasks/task-1/result',
    );
    expect(result).toEqual({ taskId: 'task-1', resultHash: 'sha256:abc' });
  });

  it('strips a trailing slash from the executor endpoint', async () => {
    const fakeFetchWithPayment = jest
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const service = new X402PaymentService(requester.secret(), {
      fetchWithPayment: fakeFetchWithPayment,
    });

    await service.payForResult('task-1', 'https://executor.example.com/');

    expect(fakeFetchWithPayment).toHaveBeenCalledWith(
      'https://executor.example.com/executor/tasks/task-1/result',
    );
  });

  it('throws when the final response is not ok', async () => {
    const fakeFetchWithPayment = jest
      .fn()
      .mockResolvedValue(new Response('payment required', { status: 402 }));
    const service = new X402PaymentService(requester.secret(), {
      fetchWithPayment: fakeFetchWithPayment,
    });

    await expect(service.payForResult('task-1', 'https://executor.example.com')).rejects.toThrow(
      /402/,
    );
  });

  describe('policy gating', () => {
    const executorPublicKey = 'GBEXECUTOR000000000000000000000000000000000000000000000';

    it('rejects the payment before signing when the executor is not on the allow-list', async () => {
      const fakeFetchWithPayment = jest.fn();
      const policyService = new PolicyService({ isRegistered: jest.fn().mockResolvedValue(false) });

      const service = new X402PaymentService(requester.secret(), {
        policyService,
        fetchWithPayment: fakeFetchWithPayment,
      });

      await expect(
        service.payForResult('task-1', 'https://executor.example.com', executorPublicKey),
      ).rejects.toBeInstanceOf(ExecutorNotAllowedError);

      expect(fakeFetchWithPayment).not.toHaveBeenCalled();
    });

    it('proceeds with payment when the executor is on the allow-list', async () => {
      const fakeFetchWithPayment = jest
        .fn()
        .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      const policyService = new PolicyService({ isRegistered: jest.fn().mockResolvedValue(true) });

      const service = new X402PaymentService(requester.secret(), {
        policyService,
        fetchWithPayment: fakeFetchWithPayment,
      });

      const result = await service.payForResult(
        'task-1',
        'https://executor.example.com',
        executorPublicKey,
      );

      expect(result).toEqual({ ok: true });
      expect(fakeFetchWithPayment).toHaveBeenCalledTimes(1);
    });

    it('skips the policy check when no executor public key is provided', async () => {
      const fakeFetchWithPayment = jest
        .fn()
        .mockResolvedValue(new Response('{}', { status: 200 }));
      const isRegistered = jest.fn();
      const policyService = new PolicyService({ isRegistered });

      const service = new X402PaymentService(requester.secret(), {
        policyService,
        fetchWithPayment: fakeFetchWithPayment,
      });

      await service.payForResult('task-1', 'https://executor.example.com');

      expect(isRegistered).not.toHaveBeenCalled();
      expect(fakeFetchWithPayment).toHaveBeenCalledTimes(1);
    });
  });
});
