import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`missing env: ${name}`);
  }
  return v;
}

async function expectJson(
  method: 'GET' | 'POST',
  url: string,
  opts?: { headers?: Record<string, string>; body?: string; expectedStatus?: number },
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
  if (opts?.body != null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: opts?.body });
  const text = await res.text();
  const expected = opts?.expectedStatus ?? 200;
  if (res.status !== expected) {
    throw new Error(`${method} ${url} expected ${expected}, got ${res.status}: ${text}`);
  }
  let json: unknown = undefined;
  if (text && /^application\/json/i.test(res.headers.get('content-type') ?? '')) {
    json = JSON.parse(text);
  }
  return { status: res.status, json, text };
}

async function runSignedSmoke(appUrl: string): Promise<void> {
  const kp = Keypair.random();
  const publicKey = kp.publicKey();

  const nonceRes = await expectJson('POST', `${appUrl}/auth/nonce`, {
    body: JSON.stringify({ publicKey }),
  });
  const nonceJson = nonceRes.json as { version: number; timestamp: number; nonce: string; ttlSeconds: number };
  if (typeof nonceJson?.timestamp !== 'number' || typeof nonceJson?.nonce !== 'string') {
    throw new Error(`unexpected nonce response: ${nonceRes.text}`);
  }

  const bodyObj = { publicKey, hello: 'baseline' };
  const bodyText = JSON.stringify(bodyObj);
  const bodyHash = sha256Hex(Buffer.from(bodyText));
  const path = '/auth/signed-smoke';
  const method = 'POST';
  const canonical = `${method}\n${path}\n${String(nonceJson.timestamp)}\n${nonceJson.nonce}\n${bodyHash}`;
  const signature = kp.sign(Buffer.from(canonical)).toString('base64');

  const signedRes = await expectJson(method, `${appUrl}${path}`, {
    headers: {
      'x-tg-public-key': publicKey,
      'x-tg-timestamp': String(nonceJson.timestamp),
      'x-tg-nonce': nonceJson.nonce,
      'x-tg-signature': signature,
    },
    body: bodyText,
    expectedStatus: 200,
  });
  const signedJson = signedRes.json as { ok: boolean; publicKey?: string };
  if (signedJson?.ok !== true) {
    throw new Error(`unexpected signed smoke response: ${signedRes.text}`);
  }
}

async function runMetricsSanity(appUrl: string): Promise<void> {
  const res = await fetch(`${appUrl}/metrics`, { method: 'GET' });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET /metrics failed: ${res.status} ${text}`);
  }
  const required = [
    'tg_auth_nonce_requests_total',
    'tg_worker_tick_total',
    'tg_outbox_unprocessed',
    'tg_stream_pending',
    'tg_stream_pending_consumer',
  ];
  for (const metric of required) {
    if (!text.includes(metric)) {
      throw new Error(`missing metric in /metrics: ${metric}`);
    }
  }
}

async function runPromSanity(promUrl: string): Promise<void> {
  const targets = await expectJson('GET', `${promUrl}/api/v1/targets`);
  const tJson = targets.json as { data?: { activeTargets?: Array<{ labels?: Record<string, string>; health?: string; scrapeUrl?: string }> } };
  const actives = tJson?.data?.activeTargets ?? [];
  const hasAppTarget = actives.some(
    (t) =>
      (t.labels?.job === 'trustgate-app' || (t.scrapeUrl ?? '').includes(':3000/metrics')) && t.health === 'up',
  );
  if (!hasAppTarget) {
    throw new Error(`prometheus has no healthy "trustgate-app" target: ${JSON.stringify(actives)}`);
  }

  const rules = await expectJson('GET', `${promUrl}/api/v1/rules`);
  const rJson = rules.json as { data?: { groups?: Array<{ name?: string; rules?: unknown[] }> } };
  const groups = rJson?.data?.groups ?? [];
  const hasTrustgate = groups.some((g) => /^trustgate-(auth|worker)$/.test(String(g.name ?? '')));
  if (!hasTrustgate || groups.length === 0) {
    throw new Error(`prometheus has no trustgate rule groups loaded: ${JSON.stringify(groups.map((g) => g.name))}`);
  }
}

async function runGrafanaSanity(grafanaUrl: string): Promise<void> {
  const health = await expectJson('GET', `${grafanaUrl}/api/health`);
  const hJson = health.json as { database?: string };
  if (hJson?.database !== 'ok') {
    throw new Error(`grafana health not ok: ${health.text}`);
  }
}

async function main(): Promise<void> {
  const appUrl = requiredEnv('BASELINE_APP_URL').replace(/\/$/, '');
  const promUrl = requiredEnv('BASELINE_PROM_URL').replace(/\/$/, '');
  const grafanaUrl = requiredEnv('BASELINE_GRAFANA_URL').replace(/\/$/, '');

  await runSignedSmoke(appUrl);
  await runMetricsSanity(appUrl);
  await runPromSanity(promUrl);
  await runGrafanaSanity(grafanaUrl);

  process.stdout.write(JSON.stringify({ ok: true, appUrl, promUrl, grafanaUrl }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`${String(err instanceof Error ? err.stack ?? err.message : err)}\n`);
  process.exit(1);
});
