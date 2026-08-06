import { WebhookService, WebhookHttpError, isWebhookRetryableError } from './webhookService';

const FAKE_URL = 'https://example.com/hook';
const DEFAULT_OPTS = { timeoutMs: 500, maxRetries: 2, baseBackoffMs: 5 };

function makeResponse(status: number, bodyText: string, extraHeaders: Record<string, string> = {}) {
  return new Response(bodyText, {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

describe('WebhookService', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('postJson happy path 2xx returns result and 1 attempt', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, JSON.stringify({ ok: true })));
    const svc = new WebhookService(DEFAULT_OPTS);
    const r = await svc.postJson(FAKE_URL, { id: 1 });
    expect(r.status).toBe(200);
    expect(r.attempts).toBe(1);
    expect(typeof r.bodyText).toBe('string');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('4xx (not 408/429) throws WebhookHttpError WITHOUT retry', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(403, JSON.stringify({ error: 'forbidden' })));
    const svc = new WebhookService(DEFAULT_OPTS);
    await expect(svc.postJson(FAKE_URL, {})).rejects.toBeInstanceOf(WebhookHttpError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('5xx → throws error after retries (at least 1 fetch called)', async () => {
    fetchSpy.mockResolvedValue(makeResponse(502, 'Bad Gateway'));
    const svc = new WebhookService({ timeoutMs: 200, maxRetries: 0, baseBackoffMs: 1 });
    let thrown: unknown = null;
    try {
      await svc.postJson(FAKE_URL, {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('429 Too Many Requests → retries baseado em Retry-After parse', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(429, 'slow', { 'Retry-After': '1' }))
      .mockResolvedValueOnce(makeResponse(201, 'ok'));
    const svc = new WebhookService({ timeoutMs: 200, maxRetries: 3, baseBackoffMs: 1 });
    const r = await svc.postJson(FAKE_URL, {});
    expect(r.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('network failure (fetch throws AbortError) → classifies as timeout and retries', async () => {
    const err = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    fetchSpy.mockRejectedValue(err);
    const svc = new WebhookService({ timeoutMs: 200, maxRetries: 1, baseBackoffMs: 1 });
    await expect(svc.postJson(FAKE_URL, {})).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('calls onAttempt hook on success and errors, with correct willRetry boolean', async () => {
    const attempts: Array<{ willRetry: boolean; statusClass?: string }> = [];
    fetchSpy
      .mockResolvedValueOnce(makeResponse(503, 'temp fail', { 'Retry-After': '1' }))
      .mockResolvedValueOnce(makeResponse(200, 'ok'));
    const svc = new WebhookService({ timeoutMs: 200, maxRetries: 3, baseBackoffMs: 1 });
    await svc.postJson(FAKE_URL, {}, {
      onAttempt: (info) => { attempts.push({ willRetry: info.willRetry, statusClass: info.statusClass }); },
    });
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0].willRetry).toBe(true);
    expect(attempts[attempts.length - 1].willRetry).toBe(false);
  });
});

describe('isWebhookRetryableError helper', () => {
  it('retry 408 and 429', () => {
    expect(isWebhookRetryableError(new WebhookHttpError('m', 408, ''))).toBe(true);
    expect(isWebhookRetryableError(new WebhookHttpError('m', 429, ''))).toBe(true);
  });
  it('do not retry 403, 404', () => {
    expect(isWebhookRetryableError(new WebhookHttpError('m', 403, ''))).toBe(false);
    expect(isWebhookRetryableError(new WebhookHttpError('m', 404, ''))).toBe(false);
  });
  it('retry AbortError', () => {
    const ab = Object.assign(new Error('stop'), { name: 'AbortError' });
    expect(isWebhookRetryableError(ab)).toBe(true);
  });
});
