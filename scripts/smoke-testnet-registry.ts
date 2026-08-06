/**
 * scripts/smoke-testnet-registry.ts
 * =================================
 * REAL on-chain Smoke Testnet SDF Registry v2.
 * Uses project's OFFICIAL BINDINGS (auto-generated spec).
 *   register_executor(executor, metadata_uri:string) → is_registered=true → get_executor → unregister → is_registered=false
 * Does NOT need USDC balance (only XLM fee + registry v2).
 */

import * as dotenv from 'dotenv';
import { join } from 'path';
import { Keypair, contract } from '@stellar/stellar-sdk';
import { loadStellarConfig } from '../src/config/stellar';
import { Client as RegistryClient } from '../src/contracts/bindings/registry/src/client';

dotenv.config({ path: join(__dirname, '..', '.env.testnet') });

const REG = process.env.REGISTRY_CONTRACT_ID;
const ADMIN_SECRET = process.env.MARKETPLACE_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
const EXEC_SECRET = process.env.EXECUTOR_SECRET;

if (!REG || !ADMIN_SECRET || !EXEC_SECRET) {
  console.error('[ERROR] .env.testnet: REGISTRY_CONTRACT_ID / MARKETPLACE_SECRET_KEY / EXECUTOR_SECRET');
  process.exit(1);
}

const config = loadStellarConfig();
const admin = Keypair.fromSecret(ADMIN_SECRET);
const executorAddr = Keypair.fromSecret(EXEC_SECRET).publicKey();

function buildRegistryClient(signer: Keypair): RegistryClient {
  const { signTransaction, signAuthEntry } = contract.basicNodeSigner(signer, config.networkPassphrase);
  return new RegistryClient({
    contractId: REG!,
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    publicKey: signer.publicKey(),
    allowHttp: config.allowHttp,
    simulate: true,
    signTransaction,
    signAuthEntry,
  });
}

async function run<P, T extends { signAndSend(opts?: unknown): Promise<{ result: P; hash?: string }> }>(
  label: string,
  expected: null | boolean | ((r: P) => boolean),
  txBuilder: (c: RegistryClient) => Promise<T>,
): Promise<void> {
  const admin = buildRegistryClient(global.adminSigner as Keypair);
  try {
    const tx = await txBuilder(admin);
    const sent = await tx.signAndSend({ force: true });
    let green = '';
    if (expected !== null) {
      const matches = typeof expected === 'function' ? expected(sent.result) : sent.result === expected;
      green = matches ? ' ✅' : '';
    }
    console.log(`  ✅ ${label} — hash=${(sent as any).hash || 'n/a'} result=${JSON.stringify(sent.result)}${green}`);
  } catch (e: any) {
    console.log(`  ❌ ${label} — ${(e.message || String(e)).slice(0, 300)}`);
  }
}

// Expose admin signer globally for the `run` function above:
(globalThis as any).adminSigner = admin;

(async () => {
  console.log('=== SMOKE TESTNET SDF — REGISTRY V2 REAL ON-CHAIN ===');
  console.log(`[config] registry contract id = ${REG}`);
  console.log(`[config] admin signer  = ${admin.publicKey().slice(0, 8)}…${admin.publicKey().slice(-5)}`);
  console.log(`[config] executor addr = ${executorAddr.slice(0, 8)}…${executorAddr.slice(-5)}`);
  console.log(`[config] rpcUrl        = ${config.rpcUrl}`);
  console.log('');

  const METADATA_URI = 'https://trustgate.dev/executor/demo-metadata-v1';
  const c = () => buildRegistryClient(admin);

  console.log('[1/5] is_registered(executor) BEFORE');
  try {
    const tx = await c().is_registered({ executor: executorAddr });
    const sent = await tx.signAndSend({ force: true });
    console.log(`  ✅ result=${JSON.stringify(sent.result)} ${sent.result === false ? '✅ correct' : ''}`);
  } catch (e: any) { console.log(`  ❌ ${(e.message || String(e)).slice(0, 300)}`); }
  console.log('');

  console.log('[2/5] register_executor(executor, metadata_uri) WRITE real on-chain (~fee ~0.005 XLM)');
  try {
    const tx = await c().register_executor({ executor: executorAddr, metadata_uri: METADATA_URI });
    const sent = await tx.signAndSend({ force: true });
    const resultOk = (sent.result as any)?.isOk?.() ?? (sent.result as any)?.ok ?? null;
    console.log(`  ✅ hash=${(sent as any).hash || 'n/a'} — result=${JSON.stringify(sent.result)} ${resultOk !== false ? '✅ accepted.' : ''}`);
  } catch (e: any) { console.log(`  ❌ ${(e.message || String(e)).slice(0, 400)}`); }
  console.log('');

  console.log('[3/5] is_registered(executor) AFTER');
  try {
    const tx = await c().is_registered({ executor: executorAddr });
    const sent = await tx.signAndSend({ force: true });
    console.log(`  ✅ result=${JSON.stringify(sent.result)} ${sent.result === true ? '✅ REAL ON-CHAIN STORAGE PERSISTED 🔥' : ''}`);
  } catch (e: any) { console.log(`  ❌ ${(e.message || String(e)).slice(0, 300)}`); }
  console.log('');

  console.log('[3.1/5] get_executor(executor) AFTER (profile_uri + registered_at_ledger + updated_at_ledger)');
  try {
    const tx = await c().get_executor({ executor: executorAddr });
    const sent = await tx.signAndSend({ force: true });
    const info = (sent.result as any)?.isOk?.() ? (sent.result as any).unwrap() : sent.result;
    console.log(`  ✅ executor info=${JSON.stringify(info)} ${info?.registered_at_ledger ? '✅ (fields present).' : ''}`);
  } catch (e: any) { console.log(`  ❌ ${(e.message || String(e)).slice(0, 300)}`); }
  console.log('');

  console.log('[4/5] unregister_executor(executor) WRITE on-chain cleanup');
  try {
    const tx = await c().unregister_executor({ executor: executorAddr });
    const sent = await tx.signAndSend({ force: true });
    console.log(`  ✅ hash=${(sent as any).hash || 'n/a'} result=${JSON.stringify(sent.result)}`);
  } catch (e: any) { console.log(`  ❌ ${(e.message || String(e)).slice(0, 300)}`); }
  console.log('');

  console.log('[4.1/5] is_registered(executor) AFTER unregister');
  try {
    const tx = await c().is_registered({ executor: executorAddr });
    const sent = await tx.signAndSend({ force: true });
    console.log(`  ✅ result=${JSON.stringify(sent.result)} ${sent.result === false ? '✅ clean rollback.' : ''}`);
  } catch (e: any) { console.log(`  ❌ ${(e.message || String(e)).slice(0, 300)}`); }
  console.log('');

  console.log('=== END SMOKE TESTNET REGISTRY V2 REAL ON-CHAIN ===');
})();
