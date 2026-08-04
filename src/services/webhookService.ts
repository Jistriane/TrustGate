export interface WebhookServiceOptions {
  timeoutMs: number;
}

export class WebhookService {
  constructor(private readonly options: WebhookServiceOptions) {}

  async postJson(url: string, payload: unknown): Promise<{ status: number; bodyText: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return { status: res.status, bodyText: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }
}

