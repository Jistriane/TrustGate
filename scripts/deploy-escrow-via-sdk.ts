import { config as loadEnv } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { loadStellarConfig } from '../src/config/stellar';
import { loadKeypairFromEnv } from '../src/utils/keypair';
import { EscrowDeployer } from '../src/services/escrowDeployer';
import { upsertEnvVar } from '../src/utils/envFile';

const ENV_PATH = join(__dirname, '..', process.env.ENV_FILE || '.env.testnet');
const WASM_PATH = join(
  __dirname,
  '..',
  'contracts',
  'escrow',
  'target',
  'wasm32-unknown-unknown',
  'release',
  'escrow.wasm',
);
const ARTIFACTS_DIR = join(__dirname, '..', 'artifacts', 'contracts', 'escrow');
const ARTIFACTS_FILE = join(ARTIFACTS_DIR, 'deployed-testnet.json');

loadEnv({ path: ENV_PATH });

async function contractIsActive(config: ReturnType<typeof loadStellarConfig>, contractId: string) {
  try {
    const server = new rpc.Server(config.rpcUrl, { allowHttp: config.allowHttp });
    await server.getContractInstance(contractId);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadStellarConfig();

  if (process.env.ESCROW_CONTRACT_ID) {
    const existing = process.env.ESCROW_CONTRACT_ID;
    console.log(`ESCROW_CONTRACT_ID already set: ${existing}`);
    if (await contractIsActive(config, existing)) {
      console.log('Existing escrow contract is active on the network — skipping redeploy.');
      return;
    }
    console.log('Existing ESCROW_CONTRACT_ID is not reachable on this network — redeploying.');
  }

  if (!existsSync(WASM_PATH)) {
    throw new Error(`Escrow WASM not found at ${WASM_PATH}. Run "npm run contracts:build" first.`);
  }

  const adminSecret = process.env.ADMIN_SECRET || process.env.MARKETPLACE_SECRET_KEY;
  if (!adminSecret) {
    throw new Error('ADMIN_SECRET or MARKETPLACE_SECRET_KEY must be set in the env file.');
  }
  const admin = loadKeypairFromEnv(process.env.ADMIN_SECRET ? 'ADMIN_SECRET' : 'MARKETPLACE_SECRET_KEY');

  const token = process.env.ESCROW_TOKEN_CONTRACT;
  if (!token) throw new Error('ESCROW_TOKEN_CONTRACT not set.');

  const marketplace = process.env.MARKETPLACE_WALLET;
  if (!marketplace) throw new Error('MARKETPLACE_WALLET not set.');

  const releaseSigner = marketplace;
  console.log(
    `Deploying escrow contract to "${config.network}" via ${config.rpcUrl}.\n` +
      `  token=${token}\n  marketplace=${marketplace}\n  release_signer=${releaseSigner}\n  deployer=${admin.publicKey()}`,
  );

  const deployer = new EscrowDeployer(config);
  const { contractId, wasmHash, initResult } = await deployer.deploy(
    WASM_PATH,
    token,
    releaseSigner,
    marketplace,
    admin,
    518_400,
  );

  upsertEnvVar(ENV_PATH, 'ESCROW_CONTRACT_ID', contractId);
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  writeFileSync(
    ARTIFACTS_FILE,
    JSON.stringify(
      {
        network: config.network,
        contractId,
        wasmHash,
        tokenContractId: token,
        marketplace,
        releaseSigner,
        deployedAt: new Date().toISOString(),
        deployerAddress: admin.publicKey(),
        initResult,
      },
      null,
      2,
    ),
  );

  console.log(`Escrow contract deployed: ${contractId}`);
  console.log(`Saved ESCROW_CONTRACT_ID to ${ENV_PATH}`);
  console.log(`Artifacts written to ${ARTIFACTS_FILE}`);
}

main().catch((err) => {
  console.error('Failed to deploy escrow contract:', err);
  process.exit(1);
});
