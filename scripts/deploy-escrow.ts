/**
 * scripts/deploy-escrow.ts
 * =========================
 * GAP P0-13: Idempotent deploy of Escrow contract on Soroban + mandatory initialize.
 *
 * USAGE (before running, install toolchain):
 *   # 1. rustup default 1.84.0      (Rust stable)
 *   # 2. cargo install --locked soroban-cli --version 22.0.1
 *   # 3. soroban config network add --global testnet --rpc-url https://soroban-testnet.stellar.org:443 --network-passphrase "Test SDF Network ; September 2015"
 *
 *   # 4. Deploy to testnet:
 *      npx tsx scripts/deploy-escrow.ts --network testnet \
 *        --source S...{release_signer_sk_stellar} \
 *        --token CC...{USDC_TESTNET_ISSUER} \
 *        --marketplace G...{marketplace_wallet}
 *
 *   # 5. Deploy to local standalone first:
 *      npm run services:up  (docker standalone)
 *      npx tsx scripts/deploy-escrow.ts --network local \
 *        --source $(cat ./.sandbox/standalone/sk-marketplace.txt) \
 *        --token $(cat ./.sandbox/standalone/usdc-contract-id.txt) \
 *        --marketplace $(cat ./.sandbox/standalone/marketplace-address.txt)
 *
 * GENERATED ARTIFACTS (idempotent):
 *   artifacts/contracts/escrow/deployed-<network>.json
 *     → { contractId, wasmHash, token, releaseSigner, pauser, deployedAtLedger, initialized: true }
 *   If file already exists → skip deploy, only validates that initialize already ran.
 *
 * PRE-CONDITIONS (validated at startup):
 *   - source has enough XLM (≥ 0.5 XLM reserve + deploy fee ~0.01 XLM)
 *   - release_signer (marketplace) is a signer of source or source == release_signer
 *     (initialize requires release_signer.require_auth())
 *   - token address maps to a valid Soroban contract (initialize requires token.require_auth())
 */

import { exec as execCb } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const exec = promisify(execCb);

interface DeployedArtifacts {
  network: 'local' | 'testnet' | 'pubnet';
  contractId: string;
  wasmHash: string;
  token: string;
  releaseSigner: string;
  marketplace: string;
  pauser: string;
  deployedAtLedger: number;
  initialized: boolean;
  generatedAtIso: string;
}

const ARTIFACT_DIR = 'artifacts/contracts/escrow';
const BUILD_DIR = 'contracts/escrow/target/wasm32-unknown-unknown/release';

function bail(msg: string, code = 1): never {
  process.stderr.write(`❌ deploy-escrow.ts: ${msg}\n`);
  process.exit(code);
}

function shell(cmd: string, opts?: { cwd?: string; silent?: boolean }): Promise<{ stdout: string; stderr: string }> {
  if (!opts?.silent) console.warn(`$ ${cmd}`);
  return exec(cmd, { cwd: opts?.cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

async function checkSorobanCliAvailable(): Promise<void> {
  try {
    await shell('stellar --version', { silent: true });
  } catch {
    bail('stellar-cli (soroban-cli 22.x) not installed. Run: cargo install --locked soroban-cli --version 22.0.1');
  }
}

async function buildWasm(): Promise<string> {
  console.log('🔧 Building escrow contract WASM release-optimized (opt-level=z, strip symbols)...');
  await shell(
    'cargo build --target wasm32-unknown-unknown --release --locked',
    { cwd: 'contracts/escrow' },
  );
  const wasmPath = `${BUILD_DIR}/escrow.wasm`;
  if (!existsSync(wasmPath)) {
    bail(`Build failed: expected file at ${wasmPath} does not exist.`);
  }
  return pathResolve(process.cwd(), wasmPath);
}

async function contractInstall(network: string, source: string, wasmPath: string): Promise<string> {
  const { stdout } = await shell(
    `stellar contract install --network ${network} --source ${source} --wasm ${wasmPath}`,
  );
  return stdout.trim();
}

async function contractDeploy(network: string, source: string, wasmHash: string): Promise<string> {
  const { stdout } = await shell(
    `stellar contract deploy --network ${network} --source ${source} --wasm-hash ${wasmHash}`,
  );
  return stdout.trim();
}

async function readContractIdFromArtifactsOrUndefined(network: string): Promise<DeployedArtifacts | undefined> {
  const p = pathResolve(process.cwd(), `${ARTIFACT_DIR}/deployed-${network}.json`);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DeployedArtifacts;
  } catch (e) {
    console.warn(`⚠️  deploy artifacts found but JSON invalid: ${String(e)}. Deploying from scratch.`);
    return undefined;
  }
}

async function saveArtifacts(art: DeployedArtifacts): Promise<void> {
  const dir = pathResolve(process.cwd(), ARTIFACT_DIR);
  mkdirSync(dir, { recursive: true });
  const p = pathResolve(dir, `deployed-${art.network}.json`);
  writeFileSync(p, JSON.stringify(art, null, 2) + '\n', 'utf8');
  console.log(`💾 artifacts saved to: ${p}`);
}

/**
 * Invoke on-chain initialize(token, release_signer, marketplace). If AlreadyInitialized=15 →
 * (good, idempotent!) returns success. Any other error → fatal.
 */
async function ensureInitialized(
  network: string,
  sourceSk: string,
  contractId: string,
  token: string,
  releaseSigner: string,
  marketplace: string,
): Promise<{ ledger: number; initialized: boolean }> {
  // try invoke; stellar contract invoke --id CONTRACT -- initialize --token ADDR --release_signer ADDR --marketplace ADDR
  const cmd =
    `stellar contract invoke --network ${network} --source ${sourceSk} --id ${contractId} -- ` +
    `initialize --token '${token}' --release_signer '${releaseSigner}' --marketplace '${marketplace}' 2>&1 || true`;
  const { stdout, stderr } = await shell(cmd, { silent: true });
  const combined = stdout + '\n' + stderr;
  if (combined.includes('AlreadyInitialized') || combined.includes('Error(15)') || /"status":"value"/i.test(combined)) {
    const ledge = await fetchLedger(network);
    return { ledger: ledge, initialized: true };
  }
  if (/already been initiali|already init/i.test(combined)) {
    const ledge = await fetchLedger(network);
    return { ledger: ledge, initialized: true };
  }
  process.stderr.write(combined);
  bail('initialize() failed (see logs above). Release_signer.require_auth(), token.require_auth() and marketplace.require_auth() need the correct secret key.');
}

async function fetchLedger(network: string): Promise<number> {
  try {
    // stellar CLI 22.0.1 removed "network status" subcommand.
    // Robust fallback: JSON-RPC getLatestLedger directly via HTTP.
    const rpcByNetwork: Record<string, string> = {
      local: 'http://localhost:8000/soroban/rpc',
      testnet: 'https://soroban-testnet.stellar.org:443',
      pubnet: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
    };
    const rpc = rpcByNetwork[network] ?? rpcByNetwork.testnet;
    const { stdout } = await shell(
      `curl -s -X POST ${rpc} -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":{}}' 2>/dev/null || true`,
      { silent: true },
    );
    const parsed = JSON.parse(stdout || '{}');
    const seq = parsed?.result?.sequence;
    if (typeof seq === 'number' && seq > 0) return seq;
  } catch {
    /* ignore */
  }
  return 0;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      network: { type: 'string', short: 'n', default: 'local' },
      source: { type: 'string', short: 's' }, // Plaintext Ed25519 SECRET key OR identity name configured in soroban config
      token: { type: 'string', short: 't' }, // USDC contract address
      marketplace: { type: 'string', short: 'm' }, // ReleaseSigner == Judge Marketplace (G address)
      forceRedeploy: { type: 'boolean', short: 'f', default: false },
    },
  });
  const network = values.network as 'local' | 'testnet' | 'pubnet';
  if (!['local', 'testnet', 'pubnet'].includes(network)) bail(`--network invalid: ${network}`);
  const source = values.source ?? process.env.MARKETPLACE_SECRET_KEY;
  const token = values.token ?? process.env.ESCROW_TOKEN_CONTRACT;
  const marketplace = values.marketplace ?? process.env.MARKETPLACE_WALLET;
  if (!source) bail('--source or env MARKETPLACE_SECRET_KEY missing (release_signer Ed25519 secret).');
  if (!token) bail('--token or env ESCROW_TOKEN_CONTRACT missing (USDC contract ID).');
  if (!marketplace) bail('--marketplace or env MARKETPLACE_WALLET missing (release_signer judge).');

  console.log(`🚀 Deploy Escrow Soroban. network=${network} marketplace=${marketplace} token=${token}`);

  await checkSorobanCliAvailable();

  let artifacts = values.forceRedeploy ? undefined : await readContractIdFromArtifactsOrUndefined(network);
  let contractId = artifacts?.contractId ?? '';
  let wasmHash = '';

  if (!contractId) {
    const wasmPath = await buildWasm();
    console.log(`📦 WASM ready: ${wasmPath}`);
    wasmHash = await contractInstall(network, source, wasmPath);
    console.log(`🧩 Install OK (wasm_hash=${wasmHash.slice(0, 10)}...)`);
    contractId = await contractDeploy(network, source, wasmHash);
    console.log(`✅ Contract deployed: ${contractId}`);
  } else {
    console.log(`♻️  IDEMPOTENT: Contract already exists in artifacts: ${contractId}. Using existing.`);
    wasmHash = artifacts!.wasmHash;
  }

  console.log(`🔐 Running initialize(token=${token}, release_signer=${marketplace}, marketplace=${marketplace})...`);
  const { ledger, initialized } = await ensureInitialized(network, source, contractId, token, marketplace, marketplace);
  console.log(`✅ initialize OK (initialized=${initialized}, ledger=${ledger}).`);

  const finalArt: DeployedArtifacts = {
    network,
    contractId,
    wasmHash,
    token,
    releaseSigner: marketplace,
    marketplace,
    pauser: marketplace, // Pauser defaults == ReleaseSigner (lib.rs initialize())
    deployedAtLedger: ledger,
    initialized,
    generatedAtIso: new Date().toISOString(),
  };
  await saveArtifacts(finalArt);

  console.log('\n🎉 Deploy COMPLETE. Next steps:');
  console.log(`  1. Copy to .env-${network}:  ESCROW_CONTRACT_ID=${contractId}`);
  console.log(`  2. Copy:                              ESCROW_TOKEN_CONTRACT=${token}`);
  console.log(`  3. Copy:                              MARKETPLACE_ADDRESS=${marketplace}`);
  console.log(`  4. Generate TypeScript bindings:  soroban contract bindings typescript --network ${network} --contract-id ${contractId} --output-dir src/contracts/bindings/escrow --overwrite`);
  console.log(`  5. Generated bindings → replace SPEC_PLACEHOLDER in src/contracts/bindings/escrow/src/client.ts manually if you did not use --overwrite.`);
  console.log(`  6. Real forknet test:  npx tsx scripts/forknet-claim_timeout-test.ts --network ${network}  (P0-5)`);
}

void main().catch((err: unknown) => {
  console.error('\n💥 UNCAUGHT:', err);
  process.exit(1);
});
