import { config as loadEnv } from 'dotenv';
import { join } from 'path';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { loadStellarConfig } from '../src/config/stellar';
import { getUsdcSacContractId } from '../src/config/usdc';
import { buildSpendingLimitPolicyParams, DEFAULT_DAILY_USDC_LIMIT } from '../src/config/smartAccount';
import { generateKeypair, loadKeypairFromEnv } from '../src/utils/keypair';
import { SmartAccountService } from '../src/services/smartAccountService';
import { upsertEnvVar } from '../src/utils/envFile';

const ENV_PATH = join(__dirname, '..', '.env');

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

  if (process.env.SMART_ACCOUNT_CONTRACT_ID) {
    const existing = process.env.SMART_ACCOUNT_CONTRACT_ID;
    console.log(`SMART_ACCOUNT_CONTRACT_ID already set: ${existing}`);
    if (await contractIsActive(config, existing)) {
      console.log('Existing smart account contract is active on the network — skipping redeploy.');
      return;
    }
    console.log('Existing SMART_ACCOUNT_CONTRACT_ID is not reachable on this network — redeploying.');
  }

  const accountWasmHash = process.env.ACCOUNT_WASM_HASH;
  if (!accountWasmHash) {
    throw new Error(
      'ACCOUNT_WASM_HASH is not set. This must be the WASM hash of an already-deployed ' +
        'OpenZeppelin smart account contract (github.com/kalepail/smart-account-kit) — ' +
        'build and upload that contract on this network first, then set the hash here.',
    );
  }

  let requester: Keypair;
  if (process.env.REQUESTER_SECRET) {
    requester = loadKeypairFromEnv('REQUESTER_SECRET');
  } else if (config.network === 'local') {
    requester = generateKeypair();
    console.log(`No REQUESTER_SECRET set, generated throwaway requester ${requester.publicKey()}`);
    const res = await fetch(`${config.horizonUrl}/friendbot?addr=${requester.publicKey()}`);
    if (!res.ok) {
      throw new Error(`Friendbot funding failed: ${res.status} ${await res.text()}`);
    }
    upsertEnvVar(ENV_PATH, 'REQUESTER_SECRET', requester.secret());
  } else {
    throw new Error('REQUESTER_SECRET must be set to deploy on a non-local network.');
  }

  console.log(`Deploying smart account to "${config.network}" via ${config.rpcUrl}...`);
  const smartAccountService = new SmartAccountService(config, accountWasmHash);
  const contractId = await smartAccountService.deployForRequester(requester);

  upsertEnvVar(ENV_PATH, 'SMART_ACCOUNT_CONTRACT_ID', contractId);
  console.log(`Smart account deployed: ${contractId}`);
  console.log(`Owner (Delegated signer): ${requester.publicKey()}`);
  console.log(`Saved SMART_ACCOUNT_CONTRACT_ID to ${ENV_PATH}`);

  if (process.env.USDC_ISSUER) {
    const usdcSacContractId = getUsdcSacContractId(config);
    const policyParams = buildSpendingLimitPolicyParams();
    console.log(
      `Policy context-rule target token: ${usdcSacContractId}, ` +
        `${DEFAULT_DAILY_USDC_LIMIT} USDC / ${policyParams.period_ledgers} ledgers (~1 day).`,
    );
    console.log(
      'Not attached yet — that requires a deployed spending-limit policy contract ' +
        '(SPENDING_LIMIT_POLICY_ADDRESS), wired via a context rule in Sprint 18.',
    );
  }
}

main().catch((err) => {
  console.error('Failed to deploy smart account:', err);
  process.exit(1);
});
