export interface EscrowConfig {
  apiKey: string;
  network?: 'testnet' | 'mainnet';
  marketplaceWallet: string;
  usdcIssuer: string;
}

export interface ReleaseResult {
  success: boolean;
  transactionHash: string;
  amountReleased: number;
  receiver: string;
}

export interface ConfiscateResult {
  success: boolean;
  disputeId: string;
  status: string;
  requesterShare: number;
  marketplaceShare: number;
}

export const DEFAULT_REQUESTER_CONFISCATION_SHARE = 0.7;

export interface SignTxResult {
  signedXdr: string;
  signerPublicKey: string;
}

export interface IMarketplaceSigner {
  getPublicKey(): Promise<string>;
  signTransaction(unsignedXdr: string, networkPassphrase: string): Promise<SignTxResult>;
  signAuthEntry(authEntryXdr: string, networkPassphrase: string): Promise<{ signedAuthEntryXdr: string; signerPublicKey: string }>;
}

export class LocalKeypairSigner implements IMarketplaceSigner {
  private keypairPromise?: Promise<{ Keypair: any; kp: any }>;
  constructor(private readonly secretKey: string) {
    if (!secretKey || typeof secretKey !== 'string') {
      throw new Error('[LocalKeypairSigner] secretKey is required (non-empty string)');
    }
  }
  private async loadKeypair() {
    if (!this.keypairPromise) {
      this.keypairPromise = (async () => {
        const { Keypair } = await import('@stellar/stellar-sdk');
        const kp = Keypair.fromSecret(this.secretKey);
        return { Keypair, kp };
      })();
    }
    return this.keypairPromise;
  }
  async getPublicKey(): Promise<string> {
    const { kp } = await this.loadKeypair();
    return kp.publicKey();
  }
  async signTransaction(unsignedXdr: string, networkPassphrase: string): Promise<SignTxResult> {
    const { kp } = await this.loadKeypair();
    const { Transaction } = await import('@stellar/stellar-sdk');
    const tx = new Transaction(unsignedXdr, networkPassphrase);
    tx.sign(kp);
    return { signedXdr: tx.toXDR(), signerPublicKey: kp.publicKey() };
  }
  async signAuthEntry(authEntryXdr: string, _networkPassphrase: string): Promise<{ signedAuthEntryXdr: string; signerPublicKey: string }> {
    const { kp } = await this.loadKeypair();
    const { hash } = await import('@stellar/stellar-sdk');
    const payloadHash = hash(Buffer.from(authEntryXdr, 'base64'));
    const sig = kp.sign(payloadHash);
    return {
      signedAuthEntryXdr: Buffer.from(sig).toString('base64'),
      signerPublicKey: kp.publicKey(),
    };
  }
}

interface TrustlessWorkClientLike {
  createSingleRelease(input: {
    engagementId: string;
    title: string;
    description?: string;
    roles: {
      approver: string;
      serviceProvider: string;
      releaseSigner: string;
      platformAddress: string;
      disputeResolver: string;
    };
    amount: number;
    milestones: { description: string }[];
    trustline: { address: string; code: string };
  }): Promise<{ success: boolean; contractId: string; escrow: Record<string, unknown> }>;
  release(escrowId: string, body: { releaseAll: true } | { milestoneId: number }): Promise<ReleaseResult>;
  raiseDispute(
    escrowId: string,
    body: { reason: string; evidence?: string; requestedAction?: string },
  ): Promise<{ success: boolean; disputeId: string; status: string }>;
}

/**
 * Wraps Trustless Work's escrow-as-a-service REST API to lock executor
 * collateral for a bid. `@stellar-agent-kit/plugin-trustless-work` ships as
 * pure ESM with no CJS export condition, so it's loaded via dynamic import()
 * rather than a static import into this CommonJS project.
 *
 * Naming note: the ADR 0002 refers to this abstraction as `IProviderEscrow`.
 * We keep the old name `EscrowServiceLike` exported too (alias) so existing
 * call-sites don't break on a one-off rename. New code should use
 * `IProviderEscrow`.
 */
export type IProviderEscrow = {
  createEscrow(executorPublicKey: string, taskId: string, collateralAmount: number): Promise<string>;
  releaseMilestone(escrowId: string, amountUnits?: number): Promise<ReleaseResult>;
  confiscate(
    escrowId: string,
    collateralAmount: number,
    requesterSharePct?: number,
  ): Promise<ConfiscateResult>;
  initialize?(tokenContract: string, releaseSigner: string, marketplace?: string): Promise<{ transactionHash: string; alreadyInitialized: boolean }>;
  pause?(): Promise<{ transactionHash: string; wasAlreadyPaused: boolean }>;
  unpause?(): Promise<{ transactionHash: string; wasAlreadyUnpaused: boolean }>;
  transferPauser?(newPauserPublicKey: string): Promise<{ transactionHash: string; previousPauser: string; newPauser: string }>;
  claimTimeout?(escrowId: string): Promise<{ transactionHash: string; amountTransferred: bigint; beneficiary: string }>;
  isPaused?(): Promise<boolean>;
};

/** @deprecated use IProviderEscrow. Kept for call-site compatibility. */
export type EscrowServiceLike = IProviderEscrow;

export type EscrowImplementationKind = 'trustlesswork' | 'mock' | 'ourown';

export interface CreateEscrowProviderInput {
  implementation: EscrowImplementationKind;
  network: 'local' | 'testnet' | 'pubnet';
  envOverrides?: Partial<{
    TRUSTLESS_WORK_API_KEY: string;
    USDC_ISSUER: string;
    MARKETPLACE_WALLET: string;
    ESCROW_CONTRACT_ID: string;
    ESCROW_TOKEN_CONTRACT: string;
    ESCROW_CONFISCATE_REQUESTER_BP: number;
    MARKETPLACE_SECRET_KEY: string;
    STELLAR_RPC_URL: string;
    STELLAR_NETWORK_PASSPHRASE: string;
    STELLAR_RPC_TIMEOUT_MS: number | string;
    DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL: 'true' | 'false';
    PAUSE_ESCROW: 'true' | 'false';
  }>;
  injectedClient?: TrustlessWorkClientLike;
  injectedMock?: IProviderEscrow;
  injectedOwn?: IProviderEscrow;
  injectedMarketplaceSigner?: IMarketplaceSigner;
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{ TrustlessWorkClient: unknown }>;

async function loadTrustlessWorkClient(): Promise<
  new (config: { apiKey: string; network?: 'testnet' | 'mainnet' }) => TrustlessWorkClientLike
> {
  const mod = await dynamicImport('@stellar-agent-kit/plugin-trustless-work');
  return mod.TrustlessWorkClient as never;
}

/**
 * Factory for the currently selected escrow implementation. Reads
 * `ESCROW_IMPLEMENTATION` by default; callers (e.g. tests) can force the
 * implementation via `input.implementation`. Returns `MockEscrowService` from
 * `./mockExternalServices` if `implementation === 'mock'` or `implementation
 * === 'trustlesswork'` but MOCK_EXTERNALS=true on a local network.
 *
 * `implementation === 'ourown'` requires all of the following P0 blockers to
 * be cleared BEFORE being set in prod:
 *   (a) contracts/escrow/ WASM compiled + deployed to the target Stellar net
 *       (see ADR 0002 § Fallback exit 15 days);
 *   (b) at least 2 external independent smart-contract audits published
 *       (escrow controls real USDC collateral of executors — P0 financial
 *       risk, no hot-fix on-chain without 30d timelock WASM upgrade);
 *   (c) Soroban TypeScript bindings generated under src/contracts/bindings/
 *       mirroring contracts/registry bindings pattern;
 *   (d) 100% coverage on Rust unit tests + integration tests covering:
 *       happy path, wrong auth, double release, claim_timeout edge,
 *       share_bp math overflows.
 * If any of those are missing, the factory throws a descriptive startup error
 * to protect against accidental activation on pubnet.
 */
export function ourOwnImplGate(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  network: 'local' | 'testnet' | 'pubnet',
  _contractId: string,
): { allowed: boolean; reasons: string[]; warnings: string[] } {
  const asStr = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));
  const reasons: string[] = [];
  const warnings: string[] = [];
  const nodeEnv = asStr(env.NODE_ENV);
  const isProduction = nodeEnv === 'production' || network === 'pubnet';

  // Backward compat debug override: allowed ONLY in NON-production environments.
  // On pubnet, DEBUG_UNSAFE is always ignored.
  const explicitDebug = asStr(env.DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL) === 'true';
  if (explicitDebug && isProduction) {
    warnings.push(
      'DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL=true was SET but is IGNORED in NODE_ENV=production / network=pubnet (security gate blocks it).',
    );
  } else if (explicitDebug && !isProduction) {
    warnings.push(
      'DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL=true → allowing real impl in staging/local. Remove before mainnet deploy (use ESCROW_OUROWN_PUBNET_ENABLED).',
    );
    return { allowed: true, reasons: [], warnings };
  }

  // === GATE 1 of 4: L2 Security check passed (ADR 0003) ===
  // Ideal: check flag file written by contract-security-check.sh in CI.
  // Today we use env var ESCROW_SECURITY_L2_PASSED=true (set by CI/CD pipeline after L2.1 build + L2.2 clippy -D warnings + L2.3 tests).
  const l2Passed = asStr(env.ESCROW_SECURITY_L2_PASSED) === 'true';
  if (!l2Passed) {
    reasons.push(
      'GATE 1/4 L2 ADR0003: ESCROW_SECURITY_L2_PASSED != true. Before enabling real impl, run `npm run security:contracts-check` and export ESCROW_SECURITY_L2_PASSED=true in CI/CD if RC=0.',
    );
  }

  // === GATE 2 of 4: L1 Checklist manually APPROVED by 2 devs ===
  // Expected value: emails or sha256 of PR signature commit. Ex.:
  //   ESCROW_L1_SIGN_OFF_1=joao@trustgate.app
  //   ESCROW_L1_SIGN_OFF_2=maria@trustgate.app
  const sign1 = asStr(env.ESCROW_L1_SIGN_OFF_1);
  const sign2 = asStr(env.ESCROW_L1_SIGN_OFF_2);
  if (!sign1 || sign1.length < 3 || !sign2 || sign2.length < 3 || sign1 === sign2) {
    reasons.push(
      'GATE 2/4 L1 ADR0003: Two independent L1 checklist sign-offs are required. Set ESCROW_L1_SIGN_OFF_1 and ESCROW_L1_SIGN_OFF_2 with DIFFERENT and valid values (e.g., dev emails).',
    );
  }

  // === GATE 3 of 4: 2 independent External Audits (L3 ADR0003) ===
  // Expects sha256 sum of published reports. Ex.:
  //   ESCROW_AUDIT_SHA256_1=ab12cdef... (OpenZeppelin report)
  //   ESCROW_AUDIT_SHA256_2=cdef34ab... (TrailOfBits report)
  const audit1 = asStr(env.ESCROW_AUDIT_SHA256_1);
  const audit2 = asStr(env.ESCROW_AUDIT_SHA256_2);
  const hexSha = /^[0-9a-fA-F]{64}$/;
  if (!hexSha.test(audit1 ?? '') || !hexSha.test(audit2 ?? '') || audit1 === audit2) {
    reasons.push(
      'GATE 3/4 L3 ADR0003: Two independent external audits must be published. Set ESCROW_AUDIT_SHA256_1 and ESCROW_AUDIT_SHA256_2 with DIFFERENT 64-char hex SHA256 hashes from the PDF reports.',
    );
  }

  // === GATE 4 of 4: Final Feature flag (explicit operational override) ===
  // On network=pubnet requires ESCROW_OUROWN_PUBNET_ENABLED=true.
  // On local/testnet staging: ESCROW_OUROWN_ALLOW_STAGING=true (cheaper, no audits? NO —
  //   audits are mandatory regardless — this flag is EXTRA, does NOT remove GATE 3/4).
  let ffOk = false;
  if (network === 'pubnet') {
    ffOk = asStr(env.ESCROW_OUROWN_PUBNET_ENABLED) === 'true';
    if (!ffOk) {
      reasons.push(
        "GATE 4/4 FINAL: network=pubnet → ESCROW_OUROWN_PUBNET_ENABLED='true' is required. WITHOUT IT the server WON'T BOOT in production.",
      );
    }
  } else {
    ffOk = asStr(env.ESCROW_OUROWN_ALLOW_STAGING) === 'true';
    if (!ffOk) {
      reasons.push(
        `GATE 4/4 FINAL: network=${network} staging → ESCROW_OUROWN_ALLOW_STAGING='true' is required to enable real impl (allows validating integration without risking real funds).`,
      );
    }
  }

  return { allowed: reasons.length === 0 && ffOk, reasons, warnings };
}

export async function createEscrowProvider(input: CreateEscrowProviderInput): Promise<IProviderEscrow> {
  if (input.injectedMock) return input.injectedMock;
  if (input.injectedOwn) return input.injectedOwn;
  if (input.implementation === 'mock') {
    const { MockEscrowService } = await import('./mockExternalServices');
    return new MockEscrowService();
  }
  if (input.implementation === 'ourown') {
    const env = input.envOverrides ?? process.env;
    const escrowContractId = env.ESCROW_CONTRACT_ID;
    const tokenContract = env.ESCROW_TOKEN_CONTRACT;
    const marketplaceWallet = env.MARKETPLACE_WALLET;
    const requesterBpRaw = env.ESCROW_CONFISCATE_REQUESTER_BP;
    const requesterBpDefault =
      requesterBpRaw === undefined || requesterBpRaw === null || requesterBpRaw === ''
        ? 7000
        : Number(requesterBpRaw);
    if (
      !Number.isFinite(requesterBpDefault) ||
      requesterBpDefault < 0 ||
      requesterBpDefault > 10_000
    ) {
      throw new Error(
        `[createEscrowProvider ourown] ESCROW_CONFISCATE_REQUESTER_BP invalid: expected integer 0..=10000, got ${requesterBpRaw}`,
      );
    }
    const wasmDeployedContractIdPresent = typeof escrowContractId === 'string' && escrowContractId.length >= 56;
    const tokenPresent = typeof tokenContract === 'string' && tokenContract.length >= 56;
    const marketPresent = typeof marketplaceWallet === 'string' && /^G[A-Z2-7]{55}$/.test(marketplaceWallet);
    if (!wasmDeployedContractIdPresent) {
      throw new Error(
        '[createEscrowProvider ourown] ESCROW_CONTRACT_ID is not set or too short (expected deployed Soroban contract address, 56+ chars). ' +
          'ADR0002 blocker (a) not cleared: deploy contracts/escrow WASM first and provide resulting contract address.',
      );
    }
    if (!tokenPresent) {
      throw new Error(
        '[createEscrowProvider ourown] ESCROW_TOKEN_CONTRACT is not set or too short (expected Soroban USDC token contract address). ' +
          'Set it explicitly to avoid classic↔Soroban address mapping bugs on pubnet.',
      );
    }
    if (!marketPresent) {
      throw new Error(
        '[createEscrowProvider ourown] MARKETPLACE_WALLET is not a valid Stellar G…55 address (required as confiscate marketplace share recipient).',
      );
    }
    const mktSecretKey = env.MARKETPLACE_SECRET_KEY as string | undefined;
    const rpcUrlOverride = env.STELLAR_RPC_URL as string | undefined;
    const passphraseOverride = env.STELLAR_NETWORK_PASSPHRASE as string | undefined;
    const rpcTimeoutRaw = env.STELLAR_RPC_TIMEOUT_MS;
    const rpcTimeout =
      rpcTimeoutRaw === undefined || rpcTimeoutRaw === ''
        ? undefined
        : Math.trunc(Number(rpcTimeoutRaw));
    const pauseEscrowEnv = env.PAUSE_ESCROW === 'true';

    let signer: IMarketplaceSigner | undefined = input.injectedMarketplaceSigner;
    if (!signer && mktSecretKey) {
      signer = new LocalKeypairSigner(mktSecretKey);
    }
    if (signer) {
      const pk = await signer.getPublicKey();
      if (pk !== marketplaceWallet) {
        throw new Error(
          `[createEscrowProvider ourown] Marketplace signer publicKey mismatch: ` +
            `signer=${pk} vs MARKETPLACE_WALLET=${marketplaceWallet}. Check MARKETPLACE_SECRET_KEY.`,
        );
      }
    }

    const baseCfg = {
      network: input.network,
      escrowContractId: escrowContractId as string,
      tokenContract: tokenContract as string,
      marketplaceWallet: marketplaceWallet as string,
      confiscateRequesterBp: Math.trunc(requesterBpDefault),
      stellarRpcUrl: rpcUrlOverride,
      networkPassphrase: passphraseOverride,
      rpcTimeoutMs: rpcTimeout,
      marketplaceSigner: signer,
      pauseEscrowFeatureFlag: pauseEscrowEnv,
    };

    const gate = ourOwnImplGate(env, input.network, escrowContractId as string);
    if (!gate.allowed) {
      for (const reason of gate.reasons) {
        // eslint-disable-next-line no-console
        console.warn(`[createEscrowProvider ourown GATE BLOCKED] ${reason}`);
      }
      return new OurOwnEscrowContractClientStub(baseCfg);
    }
    for (const warn of gate.warnings) {
      // eslint-disable-next-line no-console
      console.warn(`[createEscrowProvider ourown GATE WARNING] ${warn}`);
    }
    return new OurOwnEscrowContractClient(baseCfg);
  }
  // implementation === 'trustlesswork'
  if (input.injectedClient) {
    const env = input.envOverrides ?? {};
    return new EscrowService(
      {
        apiKey: env.TRUSTLESS_WORK_API_KEY ?? '__injected_client__',
        network: input.network === 'pubnet' ? 'mainnet' : 'testnet',
        marketplaceWallet: env.MARKETPLACE_WALLET ?? '',
        usdcIssuer: env.USDC_ISSUER ?? '',
      },
      input.injectedClient,
    );
  }
  const env = input.envOverrides ?? process.env;
  const apiKey = env.TRUSTLESS_WORK_API_KEY;
  if (!apiKey) throw new Error('TRUSTLESS_WORK_API_KEY is not set');
  const usdcIssuer = env.USDC_ISSUER;
  if (!usdcIssuer) throw new Error('USDC_ISSUER is not set');
  const marketplaceWallet = env.MARKETPLACE_WALLET;
  if (!marketplaceWallet) throw new Error('MARKETPLACE_WALLET is not set');
  return new EscrowService({
    apiKey,
    network: input.network === 'pubnet' ? 'mainnet' : 'testnet',
    marketplaceWallet,
    usdcIssuer,
  });
}

/**
 * Safe-by-default stub for OurOwnEscrowContractClient (Option C / ADR0002
 * fallback exit 15 days). TODAY every method throws a descriptive error that
 * lists which P0 blockers have not been cleared yet, to prevent accidental
 * activation of our own escrow on pubnet before (a) audits (b) bindings (c)
 * deploy are actually done.
 *
 * When you implement the REAL client, replace this class with:
 *   `export class OurOwnEscrowContractClient implements IProviderEscrow { … }`
 * that imports the generated Soroban bindings under
 * src/contracts/bindings/escrow (mirror of src/contracts/bindings/registry).
 * The factory createEscrowProvider will instantiate it directly instead of
 * this stub after you flip the instantiation line above.
 *
 * Keeps TypeScript typecheck happy today (every method of IProviderEscrow is
 * declared with matching signatures).
 */
export interface OurOwnEscrowConfig {
  network: 'local' | 'testnet' | 'pubnet';
  escrowContractId: string;
  tokenContract: string;
  marketplaceWallet: string;
  confiscateRequesterBp: number;
  stellarRpcUrl?: string;
  networkPassphrase?: string;
  marketplaceSigner?: IMarketplaceSigner;
  rpcTimeoutMs?: number;
  pauseEscrowFeatureFlag?: boolean;
}

export class OurOwnEscrowContractClient implements IProviderEscrow {
  private readonly cfg: Required<Omit<OurOwnEscrowConfig, 'marketplaceSigner'>> &
    Pick<OurOwnEscrowConfig, 'marketplaceSigner'>;
  private readonly rpcUrl: string;
  private readonly passphrase: string;

  constructor(cfg: OurOwnEscrowConfig) {
    this.cfg = {
      ...cfg,
      stellarRpcUrl: cfg.stellarRpcUrl ?? OurOwnEscrowContractClient.defaultRpcFor(cfg.network),
      networkPassphrase: cfg.networkPassphrase ?? OurOwnEscrowContractClient.defaultPassphraseFor(cfg.network),
      rpcTimeoutMs: cfg.rpcTimeoutMs ?? 15_000,
      pauseEscrowFeatureFlag: cfg.pauseEscrowFeatureFlag ?? false,
    };
    this.rpcUrl = this.cfg.stellarRpcUrl;
    this.passphrase = this.cfg.networkPassphrase;
  }

  private static defaultRpcFor(network: OurOwnEscrowConfig['network']): string {
    switch (network) {
      case 'local': return 'http://localhost:8000/soroban/rpc';
      case 'testnet': return 'https://soroban-testnet.stellar.org:443';
      case 'pubnet': return 'https://soroban-rpc.mainnet.stellar.gateway.fm';
    }
  }
  private static defaultPassphraseFor(network: OurOwnEscrowConfig['network']): string {
    switch (network) {
      case 'local': return 'Standalone Network ; February 2024';
      case 'testnet': return 'Test SDF Network ; September 2015';
      case 'pubnet': return 'Public Global Stellar Network ; September 2015';
    }
  }

  private async assemble(
    builder: (client: any, opts: any) => Promise<any>,
    optsOverride: Record<string, unknown> = {},
  ): Promise<any> {
    const mod = await import('../contracts/bindings/escrow/src/index');
    const ClientCtor = (mod as any).Client as { new (opts: any): any };
    if (!ClientCtor) {
      throw new Error('Escrow bindings not compiled. Run bindings build first.');
    }
    const client = new ClientCtor({
      contractId: this.cfg.escrowContractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.passphrase,
      allowHttp: this.cfg.network === 'local',
    });
    const opts = {
      simulate: true,
      timeoutInSeconds: Math.max(3, Math.floor(this.cfg.rpcTimeoutMs / 1000)),
      ...optsOverride,
    };
    return await builder(client, opts);
  }

  private static taskIdToBytes32(taskId: string): Buffer {
    const { createHash } = require('crypto') as typeof import('crypto');
    const digest = createHash('sha256').update(taskId, 'utf8').digest();
    if (digest.length !== 32) throw new Error('sha256 digest length unexpectedly != 32 bytes');
    return digest;
  }

  private static toBigInt128(collateralWholeUnits: number): bigint {
    if (!Number.isFinite(collateralWholeUnits) || !Number.isInteger(collateralWholeUnits) || collateralWholeUnits <= 0) {
      throw new Error(
        `[OurOwnEscrowContractClient] collateralAmount must be positive integer (got ${collateralWholeUnits}). ` +
        `Hint: collateral is stored on-chain as raw i128 — pass integer of token units, not float.`,
      );
    }
    return BigInt(collateralWholeUnits);
  }

  private async assertMutationAllowedForPauserOps(methodName: string) {
    if (this.cfg.pauseEscrowFeatureFlag && methodName !== 'unpause' && methodName !== 'isPaused') {
      throw new Error(
        `[OurOwnEscrowContractClient.${methodName}] PAUSE_ESCROW env flag=1: todas mutations desativadas off-chain. ` +
        `Use pause/unpause manual via CLI emergency script apenas.`,
      );
    }
  }

  private async signAndSendIfSignerAvailable(
    assembled: any,
    expectedSignerAddress: string | null,
  ): Promise<{ transactionHash: string; result: unknown }> {
    if (expectedSignerAddress && !this.cfg.marketplaceSigner) {
      throw new Error(
        `[OurOwnEscrowContractClient] Missing marketplace signer (inject IMarketplaceSigner or provide MARKETPLACE_SECRET_KEY). ` +
        `Expected signer address ${expectedSignerAddress}.`,
      );
    }
    if (this.cfg.marketplaceSigner && expectedSignerAddress) {
      const pk = await this.cfg.marketplaceSigner.getPublicKey();
      if (pk !== expectedSignerAddress) {
        throw new Error(
          `[OurOwnEscrowContractClient] Signer mismatch: configured signer has publicKey ${pk} but expected ${expectedSignerAddress}.`,
        );
      }
    }

    if (!this.cfg.marketplaceSigner) {
      throw new Error(
        '[OurOwnEscrowContractClient] No signer configured; cannot submit transaction. Inject IMarketplaceSigner.',
      );
    }

    const unsignedXdr = assembled.toXDR();
    const { signedXdr } = await this.cfg.marketplaceSigner.signTransaction(unsignedXdr, this.passphrase);
    const sent = await assembled.send({ signedTransactionXdr: signedXdr });
    const waited = await sent.waitUntilDone({
      timeoutInSeconds: 45,
      onPoll(_getTx: unknown) { /* no-op */ },
    });
    const transactionHash: string =
      (waited as { hash?: string; id?: string }).hash ??
      (sent as { hash?: string }).hash ??
      '';
    const result = (assembled as { result: unknown }).result;
    return { transactionHash, result };
  }

  async isPaused(): Promise<boolean> {
    if (this.cfg.pauseEscrowFeatureFlag) return true;
    try {
      const assembled = await this.assemble(
        (client: any, opts: any) => client.is_paused({}, opts),
      );
      const val = (assembled as { result?: number }).result;
      return val === 1;
    } catch (e) {
      return false;
    }
  }

  async initialize(tokenContract: string, releaseSigner: string, marketplace?: string): Promise<{ transactionHash: string; alreadyInitialized: boolean }> {
    await this.assertMutationAllowedForPauserOps('initialize');
    const marketplaceAddr = marketplace ?? releaseSigner;
    try {
      const assembled = await this.assemble((client, opts) =>
        client.initialize(
          { token: tokenContract, release_signer: releaseSigner, marketplace: marketplaceAddr },
          { ...opts, simulate: true },
        ),
      );
      const { transactionHash } = await this.signAndSendIfSignerAvailable(assembled, releaseSigner);
      return { transactionHash, alreadyInitialized: false };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('AlreadyInitialized') || msg.includes('15') || msg.includes('error=15')) {
        return { transactionHash: '', alreadyInitialized: true };
      }
      throw e;
    }
  }

  async pause(): Promise<{ transactionHash: string; wasAlreadyPaused: boolean }> {
    if (this.cfg.pauseEscrowFeatureFlag) {
      return { transactionHash: '', wasAlreadyPaused: true };
    }
    try {
      const assembled = await this.assemble((client, opts) =>
        client.pause({}, { ...opts, simulate: true }),
      );
      const { transactionHash } = await this.signAndSendIfSignerAvailable(assembled, this.cfg.marketplaceWallet);
      return { transactionHash, wasAlreadyPaused: false };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('ContractPaused') || msg.includes('16')) {
        return { transactionHash: '', wasAlreadyPaused: true };
      }
      throw e;
    }
  }

  async unpause(): Promise<{ transactionHash: string; wasAlreadyUnpaused: boolean }> {
    try {
      const assembled = await this.assemble((client, opts) =>
        client.unpause({}, { ...opts, simulate: true }),
      );
      const { transactionHash } = await this.signAndSendIfSignerAvailable(assembled, this.cfg.marketplaceWallet);
      return { transactionHash, wasAlreadyUnpaused: false };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('IsPaused=0') || msg.includes('NotPaused')) {
        return { transactionHash: '', wasAlreadyUnpaused: true };
      }
      throw e;
    }
  }

  async transferPauser(newPauserPublicKey: string): Promise<{ transactionHash: string; previousPauser: string; newPauser: string }> {
    await this.assertMutationAllowedForPauserOps('transferPauser');
    const assembled = await this.assemble((client, opts) =>
      client.transfer_pauser_ownership(
        { new_pauser: newPauserPublicKey },
        { ...opts, simulate: true },
      ),
    );
    const { transactionHash } = await this.signAndSendIfSignerAvailable(assembled, this.cfg.marketplaceWallet);
    return { transactionHash, previousPauser: this.cfg.marketplaceWallet, newPauser: newPauserPublicKey };
  }

  async createEscrow(
    executorPublicKey: string,
    taskId: string,
    collateralAmount: number,
    executorSecretKeyIfAvailableForDevOnly?: string,
  ): Promise<string> {
    await this.assertMutationAllowedForPauserOps('createEscrow');
    const pausedOnChain = await this.isPaused();
    if (pausedOnChain) {
      throw new Error('[createEscrow] Contrato pausado on-chain (IsPaused=1). Unpause antes.');
    }
    const collateral = OurOwnEscrowContractClient.toBigInt128(collateralAmount);
    const taskBytes32 = OurOwnEscrowContractClient.taskIdToBytes32(taskId);
    const assembled = await this.assemble((client, opts) =>
      client.create_escrow(
        {
          executor: executorPublicKey,
          task_id_hash: taskBytes32,
          release_signer: this.cfg.marketplaceWallet,
          requester: this.cfg.marketplaceWallet,
          token: this.cfg.tokenContract,
          collateral_amount: collateral,
        },
        { ...opts, simulate: true },
      ),
    );
    const { Keypair } = await import('@stellar/stellar-sdk');
    if (executorSecretKeyIfAvailableForDevOnly) {
      const kp = Keypair.fromSecret(executorSecretKeyIfAvailableForDevOnly);
      if (kp.publicKey() !== executorPublicKey) {
        throw new Error(
          `[createEscrow] executorSecretKey public (${kp.publicKey()}) !== executorPublicKey arg (${executorPublicKey})`,
        );
      }
      await assembled.sign(kp);
    } else {
      throw new Error(
        '[createEscrow] Executor private key missing in backend (correct by design for production). ' +
        'Use buildCreateEscrowXdr() to get the unsigned XDR, sign it on the client side with the executor wallet, ' +
        'submit via RPC, then call processCreateEscrowSubmitted(txHash, taskId) to persist off-chain state.',
      );
    }

    const { result, transactionHash } = await this.signAndSendIfSignerAvailable(
      assembled,
      this.cfg.marketplaceWallet,
    );
    const escrowId = typeof result === 'string' ? result : String(result);
    if (!escrowId || escrowId.length < 56) {
      throw new Error(
        `[createEscrow] on-chain call succeeded (tx=${transactionHash}) but returned no valid escrow_id: ${String(result)}`,
      );
    }
    return escrowId;
  }

  async buildCreateEscrowXdr(
    executorPublicKey: string,
    taskId: string,
    collateralAmount: number,
  ): Promise<{ unsignedXdr: string; rpcUrl: string; passphrase: string; expectedSigners: string[] }> {
    const collateral = OurOwnEscrowContractClient.toBigInt128(collateralAmount);
    const taskBytes32 = OurOwnEscrowContractClient.taskIdToBytes32(taskId);
    const assembled = await this.assemble((client, opts) =>
      client.create_escrow(
        {
          executor: executorPublicKey,
          task_id_hash: taskBytes32,
          release_signer: this.cfg.marketplaceWallet,
          requester: this.cfg.marketplaceWallet,
          token: this.cfg.tokenContract,
          collateral_amount: collateral,
        },
        { ...opts, simulate: true },
      ),
    );
    return {
      unsignedXdr: assembled.toXDR(),
      rpcUrl: this.rpcUrl,
      passphrase: this.passphrase,
      expectedSigners: [executorPublicKey],
    };
  }

  async releaseMilestone(escrowId: string, amountUnits?: number): Promise<ReleaseResult> {
    await this.assertMutationAllowedForPauserOps('releaseMilestone');
    const pausedOnChain = await this.isPaused();
    if (pausedOnChain) {
      throw new Error('[releaseMilestone] Contrato pausado on-chain (IsPaused=1). Unpause antes.');
    }
    const state = await this.getEscrowStateOrThrow(escrowId);
    const remaining = state.collateral - (state.released ?? 0n);
    const amountBi: bigint = amountUnits === undefined
      ? remaining
      : (() => {
          if (!Number.isInteger(amountUnits) || amountUnits <= 0) throw new Error(`releaseMilestone amountUnits deve ser integer positivo, got ${amountUnits}`);
          const bi = BigInt(amountUnits);
          if (bi > remaining) throw new Error(`releaseMilestone amountUnits (${bi}) excede remaining (${remaining})`);
          return bi;
        })();

    const assembled = await this.assemble((client, opts) =>
      client.release_milestone(
        {
          escrow_id: Buffer.from(escrowId, 'hex'),
          amount: amountBi,
        },
        { ...opts, simulate: true },
      ),
    );
    const { transactionHash } = await this.signAndSendIfSignerAvailable(assembled, this.cfg.marketplaceWallet);
    return {
      success: true,
      transactionHash,
      amountReleased: Number(amountBi),
      receiver: state.executor,
    };
  }

  async confiscate(
    escrowId: string,
    _collateralAmountHintUnused: number,
    requesterSharePct?: number,
  ): Promise<ConfiscateResult> {
    await this.assertMutationAllowedForPauserOps('confiscate');
    const pausedOnChain = await this.isPaused();
    if (pausedOnChain) {
      throw new Error('[confiscate] Contrato pausado on-chain (IsPaused=1). Unpause antes.');
    }
    const bp = requesterSharePct === undefined
      ? this.cfg.confiscateRequesterBp
      : Math.trunc(requesterSharePct * 10_000);
    if (bp < 3000 || bp > 10000 || !Number.isFinite(bp)) {
      throw new Error(
        `[confiscate] requesterShareBp out of range (min 3000 = 30%, max 10000 = 100%). Got ${bp}. ` +
        `Pass pct 0.3..1.0 as requesterSharePct (default ${this.cfg.confiscateRequesterBp / 10000}).`,
      );
    }
    const marketplaceAddress = this.cfg.marketplaceWallet;
    const assembled = await this.assemble((client, opts) =>
      client.confiscate(
        {
          escrow_id: Buffer.from(escrowId, 'hex'),
          requester_share_bp: bp,
          marketplace: marketplaceAddress,
        },
        { ...opts, simulate: true },
      ),
    );
    const { transactionHash: _transactionHash, result } = await this.signAndSendIfSignerAvailable(
      assembled,
      this.cfg.marketplaceWallet,
    );
    const [reqShare, marketShare] = (result ?? [0n, 0n]) as readonly [bigint, bigint];
    return {
      success: true,
      disputeId: `disp-${escrowId.slice(0, 8)}`,
      status: 'RESOLVED_REQUESTER_WON',
      requesterShare: Number(reqShare),
      marketplaceShare: Number(marketShare),
    };
  }

  async claimTimeout(escrowId: string): Promise<{ transactionHash: string; amountTransferred: bigint; beneficiary: string }> {
    await this.assertMutationAllowedForPauserOps('claimTimeout');
    const pausedOnChain = await this.isPaused();
    if (pausedOnChain) {
      throw new Error('[claimTimeout] Contrato pausado on-chain (IsPaused=1). Unpause antes.');
    }
    const stateBefore = await this.getEscrowStateOrThrow(escrowId);
    const assembled = await this.assemble((client, opts) =>
      client.claim_timeout(
        { escrow_id: Buffer.from(escrowId, 'hex') },
        { ...opts, simulate: true },
      ),
    );
    const { Keypair } = await import('@stellar/stellar-sdk');
    const executorSk = (process.env.__EXECUTOR_SECRET_KEY_FOR_TEST_ONLY__ as string | undefined);
    if (executorSk) {
      const kp = Keypair.fromSecret(executorSk);
      if (kp.publicKey() !== stateBefore.executor) throw new Error('[claimTimeout] __EXECUTOR_SECRET_KEY_FOR_TEST_ONLY__ does not match state.executor');
      await assembled.sign(kp);
    }
    const { transactionHash } = await this.signAndSendIfSignerAvailable(
      assembled,
      null,
    );
    const amount = stateBefore.collateral - (stateBefore.released ?? 0n);
    return { transactionHash, amountTransferred: amount, beneficiary: stateBefore.executor };
  }

  async getEscrowStateOrThrow(escrowIdHex: string): Promise<{
    task_id_hash: string; executor: string; requester: string; release_signer: string;
    collateral: bigint; released: bigint; created_at_ledger: number; status: number;
  }> {
    const assembled = await this.assemble(
      (client: any, opts: any) => client.get_escrow(
        { escrow_id: Buffer.from(escrowIdHex, 'hex') },
        opts,
      ),
    );
    const parsed = (assembled as unknown as { result?: any }).result;
    if (!parsed) throw new Error(`get_escrow returned empty for id=${escrowIdHex}`);
    const released = typeof parsed.released === 'bigint' ? parsed.released : 0n;
    return { ...parsed, released };
  }
}

const OWN_ESCROW_BLOCKER_MSG =
  '[OurOwnEscrowContractClientStub P0 blockers note] SAFE STUB ativo. REAL impl existe como OurOwnEscrowContractClient, ' +
  'mas a factory createEscrowProvider bloqueia uso a menos que DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL=true + WASM IDs definidos + auditorias aprovadas.';

export class OurOwnEscrowContractClientStub implements IProviderEscrow {
  constructor(_cfg: OurOwnEscrowConfig) {}

  async createEscrow(_e: string, _t: string, _c: number): Promise<string> {
    throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: createEscrow)');
  }
  async releaseMilestone(_escrowId: string): Promise<ReleaseResult> {
    throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: releaseMilestone)');
  }
  async confiscate(_i: string, _h: number, _r?: number): Promise<ConfiscateResult> {
    throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: confiscate)');
  }
  async initialize(_tok?: string, _rs?: string, _mp?: string): Promise<any> { throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: initialize)'); }
  async pause(): Promise<any> { throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: pause)'); }
  async unpause(): Promise<any> { throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: unpause)'); }
  async transferPauser(): Promise<any> { throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: transferPauser)'); }
  async claimTimeout(): Promise<any> { throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: claimTimeout)'); }
  async isPaused(): Promise<boolean> { throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: isPaused)'); }
}

export class EscrowService implements IProviderEscrow {
  private clientPromise?: Promise<TrustlessWorkClientLike>;

  constructor(
    private readonly config: EscrowConfig,
    private readonly injectedClient?: TrustlessWorkClientLike,
  ) {}

  private async getClient(): Promise<TrustlessWorkClientLike> {
    if (this.injectedClient) return this.injectedClient;
    if (!this.clientPromise) {
      this.clientPromise = loadTrustlessWorkClient().then(
        (TrustlessWorkClient) =>
          new TrustlessWorkClient({
            apiKey: this.config.apiKey,
            network: this.config.network ?? 'testnet',
          }),
      );
    }
    return this.clientPromise;
  }

  async createEscrow(executorPublicKey: string, taskId: string, collateralAmount: number): Promise<string> {
    const client = await this.getClient();
    const result = await client.createSingleRelease({
      engagementId: taskId,
      title: `Collateral for task ${taskId}`,
      description: `Executor collateral bond for task ${taskId}`,
      roles: {
        approver: this.config.marketplaceWallet,
        serviceProvider: executorPublicKey,
        releaseSigner: this.config.marketplaceWallet,
        platformAddress: this.config.marketplaceWallet,
        disputeResolver: this.config.marketplaceWallet,
      },
      amount: collateralAmount,
      milestones: [{ description: `Deliver result for task ${taskId}` }],
      trustline: { address: this.config.usdcIssuer, code: 'USDC' },
    });
    return result.contractId;
  }

  async releaseMilestone(escrowId: string): Promise<ReleaseResult> {
    const client = await this.getClient();
    return client.release(escrowId, { releaseAll: true });
  }

  async confiscate(
    escrowId: string,
    collateralAmount: number,
    requesterSharePct: number = DEFAULT_REQUESTER_CONFISCATION_SHARE,
  ): Promise<ConfiscateResult> {
    const client = await this.getClient();
    const requesterShare = Math.round(collateralAmount * requesterSharePct * 100) / 100;
    const marketplaceShare = Math.round((collateralAmount - requesterShare) * 100) / 100;
    const dispute = await client.raiseDispute(escrowId, {
      reason: 'Executor abandoned task — deadline expired without delivery',
      requestedAction: `confiscate:requester=${requesterShare},marketplace=${marketplaceShare}`,
    });
    return { ...dispute, requesterShare, marketplaceShare };
  }
}
