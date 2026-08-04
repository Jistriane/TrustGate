import { withRetry } from './retry';

describe('withRetry', () => {
  it('returns the result on the first successful attempt', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries after failures and eventually succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Account not found: G...'))
      .mockRejectedValueOnce(new Error('Account not found: G...'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { retries: 3, baseDelayMs: 1 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error once retries are exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('Account not found: G...'));

    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('Account not found');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient (business-logic) error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('AlreadyRegistered'));

    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).rejects.toThrow('AlreadyRegistered');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
