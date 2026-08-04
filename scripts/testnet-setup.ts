import { config as loadEnv } from 'dotenv';
import { join } from 'path';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { upsertEnvVar } from '../src/utils/envFile';

const ENV_PATH = join(__dirname, '..', '.env.testnet');
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

loadEnv({ path: ENV_PATH });

const horizon = new Horizon.Server(HORIZON_URL);

async function fundOnFriendbot(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed for ${publicKey}: ${res.status} ${await res.text()}`);
  }
}

async function addUsdcTrustline(kp: Keypair): Promise<void> {
  const account = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', USDC_ISSUER) }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
}

function loadOrCreateKeypair(envVar: string): { keypair: Keypair; isNew: boolean } {
  const existing = process.env[envVar];
  if (existing) {
    return { keypair: Keypair.fromSecret(existing), isNew: false };
  }
  return { keypair: Keypair.random(), isNew: true };
}

async function setUpAccount(
  label: string,
  envVar: string,
): Promise<{ keypair: Keypair; isNew: boolean }> {
  const { keypair, isNew } = loadOrCreateKeypair(envVar);

  if (isNew) {
    console.log(`[${label}] generated ${keypair.publicKey()}, funding via Friendbot...`);
    await fundOnFriendbot(keypair.publicKey());
    upsertEnvVar(ENV_PATH, envVar, keypair.secret());
  } else {
    console.log(`[${label}] reusing existing ${keypair.publicKey()} from .env.testnet`);
  }

  console.log(`[${label}] adding USDC trustline (issuer ${USDC_ISSUER})...`);
  try {
    await addUsdcTrustline(keypair);
  } catch (err) {
    console.warn(`[${label}] trustline setup failed (may already exist): ${(err as Error).message}`);
  }

  return { keypair, isNew };
}

async function main(): Promise<void> {
  console.log(`Setting up Stellar testnet accounts via ${FRIENDBOT_URL} and ${HORIZON_URL}...\n`);

  const admin = await setUpAccount('admin/marketplace', 'ADMIN_SECRET');
  upsertEnvVar(ENV_PATH, 'MARKETPLACE_WALLET', admin.keypair.publicKey());

  const requester = await setUpAccount('requester', 'REQUESTER_SECRET');
  const executor = await setUpAccount('executor', 'EXECUTOR_SECRET');

  console.log('\nAccounts ready:');
  console.log(`  admin/marketplace: ${admin.keypair.publicKey()}`);
  console.log(`  requester:         ${requester.keypair.publicKey()}`);
  console.log(`  executor:          ${executor.keypair.publicKey()}`);

  console.log('\nNext steps (manual, web/captcha-only — cannot be scripted):');
  console.log('  1. Open https://faucet.circle.com');
  console.log('  2. Select "Stellar testnet"');
  console.log(`  3. Paste the REQUESTER address and request USDC: ${requester.keypair.publicKey()}`);
  console.log('     (the requester pays the listing fee and the x402 result fee in USDC)');
  console.log('\nAll other setup (contract deploy, XLM funding, trustlines) is done.');
}

main().catch((err) => {
  console.error('Testnet setup failed:', err);
  process.exit(1);
});
