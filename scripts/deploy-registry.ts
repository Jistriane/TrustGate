import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { loadStellarConfig } from '../src/config/stellar';
import { generateKeypair, loadKeypairFromEnv } from '../src/utils/keypair';
import { RegistryDeployer } from '../src/services/registryDeployer';
import { upsertEnvVar } from '../src/utils/envFile';

const ENV_PATH = join(__dirname, '..', process.env.ENV_FILE || '.env');
const WASM_PATH = join(
  __dirname,
  '..',
  'contracts',
  'registry',
  'target',
  'wasm32v1-none',
  'release',
  'registry.wasm',
);

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

  if (process.env.REGISTRY_CONTRACT_ID) {
    const existing = process.env.REGISTRY_CONTRACT_ID;
    console.log(`REGISTRY_CONTRACT_ID already set: ${existing}`);
    if (await contractIsActive(config, existing)) {
      console.log('Existing registry contract is active on the network — skipping redeploy.');
      return;
    }
    console.log('Existing REGISTRY_CONTRACT_ID is not reachable on this network — redeploying.');
  }

  if (!existsSync(WASM_PATH)) {
    throw new Error(`Registry WASM not found at ${WASM_PATH}. Run "npm run contracts:build" first.`);
  }

  let admin: Keypair;
  if (process.env.ADMIN_SECRET) {
    admin = loadKeypairFromEnv('ADMIN_SECRET');
  } else if (config.network === 'local') {
    admin = generateKeypair();
    console.log(`No ADMIN_SECRET set, generated throwaway admin ${admin.publicKey()}`);
    const res = await fetch(`${config.horizonUrl}/friendbot?addr=${admin.publicKey()}`);
    if (!res.ok) {
      throw new Error(`Friendbot funding failed: ${res.status} ${await res.text()}`);
    }
    upsertEnvVar(ENV_PATH, 'ADMIN_SECRET', admin.secret());
  } else {
    throw new Error('ADMIN_SECRET must be set to deploy on a non-local network.');
  }

  console.log(`Deploying registry contract to "${config.network}" via ${config.rpcUrl}...`);
  const deployer = new RegistryDeployer(config);
  const contractId = await deployer.deploy(WASM_PATH, admin);

  upsertEnvVar(ENV_PATH, 'REGISTRY_CONTRACT_ID', contractId);
  console.log(`Registry contract deployed: ${contractId}`);
  console.log(`Saved REGISTRY_CONTRACT_ID to ${ENV_PATH}`);
}

main().catch((err) => {
  console.error('Failed to deploy registry contract:', err);
  process.exit(1);
});
