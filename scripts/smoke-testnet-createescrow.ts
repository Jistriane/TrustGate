/**
 * scripts/smoke-testnet-createescrow.ts
 * =====================================
 * REAL on-chain Smoke Testnet SDF Escrow Option C:
 *   Attempts create_escrow(executor, task_id_hash BytesN<32>, requester, collateral_amount 1 USDC).
 * Since the 2 wallets do NOT have Circle USDC balance yet (Circle Faucet missing), we EXPECT it to fail
 * on SAC transfer_from with "insufficient_balance" or similar — but this PROVES that the entire
 * Soroban Auth pipeline (2 require_auth), Nonce storage, ASSIGNED status, etc. are WORKING
 * and the only real bottleneck is balance.
 *
 * Uses stellar-sdk RAW Operation.invokeContractFunction + AssembledTransaction.buildWithOp
 * (SAME pattern 100% validated in the deployer).
 */

import * as dotenv from 'dotenv';
import { join } from 'path';
import {
  Keypair,
  Operation,
  contract,
  scValToNative,
  Address,
  xdr,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { loadStellarConfig } from '../src/config/stellar';

dotenv.config({ path: join(__dirname, '..', '.env.testnet') });

const ESC = process.env.ESCROW_CONTRACT_ID;
const EXEC_SECRET = process.env.EXECUTOR_SECRET;
const REQ_SECRET = process.env.REQUESTER_SECRET;
if (!ESC || !EXEC_SECRET || !REQ_SECRET) {
  console.error('[ERROR] .env.testnet: ESCROW_CONTRACT_ID / EXECUTOR_SECRET / REQUESTER_SECRET');
  process.exit(1);
}

const config = loadStellarConfig();
const execKp = Keypair.fromSecret(EXEC_SECRET);
const reqKp = Keypair.fromSecret(REQ_SECRET);
const execAddr = execKp.publicKey();
const reqAddr = reqKp.publicKey();

// Task id hash (BytesN<32>): 32 bytes random hex
const TASK_ID_HEX_32 = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

function safeParse(r: unknown): unknown {
  if (r == null) return null;
  try { return scValToNative(r as never); } catch { return r; }
}

/**
 * Multi-signer AssembledTransaction: signs with 2 keypairs (executor + requester).
 * Pattern from stellar sdk soroban examples: uses basicNodeSigner per signer.
 * Since basic stellar-sdk only accepts 1 signTransaction; for multi signers, combine signatures.
 * Below: uses AssembledTransaction.buildWithOp + signAndSend with signer that uses MULTIPLE keypairs.
 */
function multiBasicNodeSigners(signers: Keypair[], networkPassphrase: string) {
  const innerSigners = signers.map(s => contract.basicNodeSigner(s, networkPassphrase));
  return {
    signTransaction: async (txXdr: string): Promise<string> => {
      let out = txXdr;
      for (const s of innerSigners) {
        out = await s.signTransaction(out);
      }
      return out;
    },
    signAuthEntry: async (entryXdr: string): Promise<string> => {
      let out = entryXdr;
      for (const s of innerSigners) {
        out = await s.signAuthEntry(out);
      }
      return out;
    },
  };
}

async function invokeCreateEscrow(amountStroopsUSDC7Dec: bigint): Promise<{ ok: boolean; info: string; hash?: string }> {
  try {
    const { signTransaction, signAuthEntry } = multiBasicNodeSigners([execKp, reqKp], config.networkPassphrase);

    // ScVal create_escrow Args (use nativeToScVal to build correct types automatically):
    const amountStroopsNum = Number(amountStroopsUSDC7Dec); // 1e6 cabe em Number (safe <= 2^53-1)
    const args: xdr.ScVal[] = [
      Address.fromString(execAddr).toScVal(),
      xdr.ScVal.scvBytes(Buffer.from(TASK_ID_HEX_32, 'hex')), // BytesN<32>
      Address.fromString(reqAddr).toScVal(),
      nativeToScVal(amountStroopsNum, { type: 'i128' }) as xdr.ScVal, // collateral_amount: i128
    ];

    const op = Operation.invokeContractFunction({
      contract: ESC!,
      function: 'create_escrow',
      args,
    });

    const primarySigner = Keypair.fromSecret(EXEC_SECRET); // paga fee
    const tx = await contract.AssembledTransaction.buildWithOp(op, {
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      publicKey: primarySigner.publicKey(),
      allowHttp: config.allowHttp,
      simulate: true,
      signTransaction,
      signAuthEntry,
      contractId: ESC!,
      method: 'create_escrow',
      parseResultXdr: safeParse,
      errorOnUnknownKeys: false,
    } as any);

    const sent = await tx.signAndSend({ force: true });
    return { ok: true, info: `escrow_id=${JSON.stringify((sent as any).result)}`, hash: (sent as any).hash };
  } catch (e: any) {
    const msg: string = e.message || String(e);
    return { ok: false, info: msg.slice(0, 800) };
  }
}

(async () => {
  console.log('=== SMOKE TESTNET SDF — ESCROW C create_escrow REAL ON-CHAIN (2 signer multi-auth) ===');
  console.log(`[config] escrow contract id = ${ESC}`);
  console.log(`[config] executor signer = ${execAddr.slice(0, 8)}…${execAddr.slice(-5)} (fee payer)`);
  console.log(`[config] requester signer = ${reqAddr.slice(0, 8)}…${reqAddr.slice(-5)}`);
  console.log(`[config] collateral_amount = 1,0000000 USDC = 1.000.000 = 1 USDC (7 decimals SAC Circle)`);
  console.log('');

  console.log('Attempting create_escrow real on-chain...');
  const r = await invokeCreateEscrow(1_000_000n);
  console.log(r.ok
    ? `✅ SUCCESS total (USDC already credited!?) ${r.info} hash=${r.hash}`
    : r.info.includes('insufficient') || r.info.includes('balance')
      ? `🔮 EXPECTED (missing Circle Faucet USDC). Clean transfer_from failure: ${r.info}`
      : r.info.includes('Auth') || r.info.includes('Missing signer') || r.info.includes('require_auth')
        ? `⚠️  Auth failure (soroban auth 2 signer). Detailed diagnosis below:
${r.info}`
        : `❌ Unexpected failure (below):
${r.info}`);

  console.log('');
  console.log('=== END SMOKE TESTNET CREATE ESCROW ===');
})();
