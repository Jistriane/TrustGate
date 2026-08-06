#!/usr/bin/env ts-node
/*
 * scripts/ttl-monitor.ts
 * =======================
 * P1-B.2 ADR 0004 §4 Operation.
 *
 * ⚠️ DEFAULT MODE V14+ (2026-08-06):
 *   You DO NOT need to run THIS script standalone. TrustGate ALREADY integrates
 *   EscrowTtlMonitorService AUTOMATICALLY in src/server.ts if env var
 *   ESCROW_CONTRACT_ID is set. Gauge tg_escrow_contract_instance_ttl_days
 *   appears in the SAME /metrics endpoint of the app (app:3000/metrics).
 *   Prometheus already has trustgate-app:3000 job — no new scrape needed.
 *
 * WHEN TO USE THIS STANDALONE SCRIPT:
 *   1. You do NOT want to run together with main app (separate deploy).
 *   2. You set DISABLE_TTL_MONITOR=true in the app to turn off the integrated one.
 *   3. You want to run 1-shot to test connectivity without HTTP server.
 *
 * Standalone TTL (instance storage) monitor of the on-chain escrow contract.
 * Runs `soroban contract fetch --output json` (Soroban CLI 22.0.1) and publishes
 * prometheus gauge `tg_escrow_contract_instance_ttl_days` on a lightweight HTTP
 * endpoint (default :9465/metrics). Prometheus scrapes this endpoint.
 *
 * Usage on staging/testnet/PROD ONLY IF THIS IS THE DESIRED MODE (run as systemd unit):
 *
 *   PORT=9465 NETWORK=testnet ESCROW_CONTRACT_ID=CDX... \
 *   DISABLE_TTL_MONITOR=true MARKETPLACE_SECRET_KEY=SC... \
 *   npx ts-node --transpile-only scripts/ttl-monitor.ts
 *
 * Standalone one-shot (once, for quick tests, without HTTP server):
 *
 *   NETWORK=testnet ESCROW_CONTRACT_ID=CDX... npm run metrics:ttl:once
 *
 * Associated metrics in Prometheus:
 *   - prom/alerts/trustgate-alerts.yml (trustgate-contract-lifecycle group)
 *     TrustGateEscrowContractInstanceTtlLowWarning  < 60d (1d for)
 *     TrustGateEscrowContractInstanceTtlLowCritical < 30d (2h for)
 *
 * Action when Critical alert fires:
 *   soroban contract extend --network testnet \
 *     --id $ESCROW_CONTRACT_ID --wasm-hash $WASM_HASH \
 *     --threshold 69120 --extend-to 518400
 */

import 'dotenv/config';

import { EscrowTtlMonitorService } from '../src/services/escrowTtlMonitorService';
import express from 'express';
import { metricsRegistry } from '../src/config/metrics';
import { logger } from '../src/config/logger';

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`ttl-monitor.ts: env ${name} missing.\n`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const network = (process.env.NETWORK ?? 'local') as 'local' | 'testnet' | 'pubnet';
  const contractId = envOrThrow('ESCROW_CONTRACT_ID');
  const once = process.argv.includes('--once') || process.env.ONCE === 'true';

  const svc = new EscrowTtlMonitorService({
    network,
    contractId,
    ledgerSeconds: 5,
    defaultFallbackDays: 30,
    cronExpression: '0 */6 * * *',
  });

  const tickRes = await svc.tickOnce();
  logger.info({ tickRes }, 'ttl-monitor initial tick completed.');

  if (once) {
    process.exit(0);
  }

  const app = express();
  const port = parseInt(process.env.PORT ?? '9465', 10);
  app.get('/metrics', async (_req, res) => {
    try {
      res.set('Content-Type', metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });
  app.get('/healthz', (_req, res) => {
    const daysVal = (metricsRegistry.getSingleMetric('tg_escrow_contract_instance_ttl_days') as any)?.get?.()?.values?.[0]?.value;
    res.status(typeof daysVal === 'number' ? 200 : 503).json({
      ok: typeof daysVal === 'number',
      network,
      contractId: contractId.slice(0, 10) + '…',
      ttlDays: daysVal ?? null,
    });
  });
  app.listen(port, () => {
    logger.info({ port }, 'ttl-monitor listening on /metrics and /healthz.');
  });

  svc.schedule();
}

void main().catch((err) => {
  console.error('ttl-monitor.ts UNCAUGHT:', err);
  process.exit(1);
});
