import { Keypair, contract } from '@stellar/stellar-sdk';
import { StellarConfig } from '../config/stellar';
import { withRetry } from '../utils/retry';
import { logger } from '../config/logger';

export interface ExecutorInfo {
  metadata_uri: string;
  profile_uri?: string;
  updated_at_ledger?: number;
  registered_at_ledger?: number;
}

interface ContractResult<T> {
  isOk(): boolean;
  isErr(): boolean;
  unwrap(): T;
  unwrapErr(): { message: string };
}

function unwrapResult<T>(result: ContractResult<T>): T {
  if (result.isErr()) {
    throw new Error(result.unwrapErr().message);
  }
  return result.unwrap();
}

interface RegistryContractMethods {
  register_executor(args: { executor: string; metadata_uri: string }): Promise<contract.AssembledTransaction<ContractResult<undefined>>>;
  update_executor(args: { executor: string; profile_uri: string }): Promise<contract.AssembledTransaction<ContractResult<undefined>>>;
  unregister_executor(args: { executor: string }): Promise<contract.AssembledTransaction<ContractResult<undefined>>>;
  is_registered(args: { executor: string }): Promise<contract.AssembledTransaction<boolean>>;
  get_executor(args: { executor: string }): Promise<contract.AssembledTransaction<ContractResult<ExecutorInfo>>>;
}

type RegistryClient = contract.Client & RegistryContractMethods;

export interface RegistryServiceLike {
  registerExecutor(executor: Keypair, metadataUri: string): Promise<void>;
  updateExecutor(executor: Keypair, profileUri: string): Promise<void>;
  unregisterExecutor(executor: Keypair): Promise<void>;
  isRegistered(executorPublicKey: string): Promise<boolean>;
  getExecutor(executorPublicKey: string): Promise<ExecutorInfo>;
}

export class RegistryService implements RegistryServiceLike {
  private readonly pauseRegistry: boolean;

  constructor(
    private readonly config: StellarConfig,
    private readonly contractId: string,
    envOverrides?: Partial<{ PAUSE_REGISTRY: 'true' | 'false' }>,
  ) {
    const env = envOverrides ?? process.env;
    this.pauseRegistry = env.PAUSE_REGISTRY === 'true';
  }

  private assertNotPaused(method: string) {
    if (this.pauseRegistry) {
      throw new Error(
        `[RegistryService.${method}] PAUSE_REGISTRY=1 (off-chain feature flag). Mutation operations are blocked.`,
      );
    }
  }

  private async readOnlyClient(): Promise<RegistryClient> {
    return contract.Client.from<RegistryContractMethods>({
      contractId: this.contractId,
      rpcUrl: this.config.rpcUrl,
      networkPassphrase: this.config.networkPassphrase,
      allowHttp: this.config.allowHttp,
    }) as Promise<RegistryClient>;
  }

  private async writeClient(executor: Keypair): Promise<RegistryClient> {
    const { signTransaction, signAuthEntry } = contract.basicNodeSigner(
      executor,
      this.config.networkPassphrase,
    );
    return (await contract.Client.from<RegistryContractMethods>({
      contractId: this.contractId,
      rpcUrl: this.config.rpcUrl,
      networkPassphrase: this.config.networkPassphrase,
      allowHttp: this.config.allowHttp,
      publicKey: executor.publicKey(),
      signTransaction,
      signAuthEntry,
    })) as RegistryClient;
  }

  async registerExecutor(executor: Keypair, metadataUri: string): Promise<void> {
    this.assertNotPaused('registerExecutor');
    await withRetry(async () => {
      const client = await this.writeClient(executor);
      const tx = await client.register_executor({
        executor: executor.publicKey(),
        metadata_uri: metadataUri,
      });
      const sent = await tx.signAndSend();
      unwrapResult(sent.result);
      logger.info({ executor: executor.publicKey(), len: metadataUri.length }, '[Registry] executor registered on-chain');
    });
  }

  async updateExecutor(executor: Keypair, profileUri: string): Promise<void> {
    this.assertNotPaused('updateExecutor');
    if (!profileUri) throw new Error('[RegistryService.updateExecutor] profileUri vazio proibido (RegistryError::ProfileUriEmpty=3)');
    if (Buffer.byteLength(profileUri, 'utf8') > 4096) {
      throw new Error(`[RegistryService.updateExecutor] profileUri length ${Buffer.byteLength(profileUri, 'utf8')} > 4096 max (RegistryError::ProfileUriTooLong=4)`);
    }
    await withRetry(async () => {
      const client = await this.writeClient(executor);
      const tx = await client.update_executor({
        executor: executor.publicKey(),
        profile_uri: profileUri,
      });
      const sent = await tx.signAndSend();
      unwrapResult(sent.result);
      logger.info({ executor: executor.publicKey(), len: profileUri.length }, '[Registry] executor profile_uri updated on-chain');
    });
  }

  async unregisterExecutor(executor: Keypair): Promise<void> {
    this.assertNotPaused('unregisterExecutor');
    await withRetry(async () => {
      const client = await this.writeClient(executor);
      const tx = await client.unregister_executor({
        executor: executor.publicKey(),
      });
      const sent = await tx.signAndSend();
      unwrapResult(sent.result);
      logger.info({ executor: executor.publicKey() }, '[Registry] executor unregistered on-chain');
    });
  }

  async isRegistered(executorPublicKey: string): Promise<boolean> {
    return withRetry(async () => {
      const client = await this.readOnlyClient();
      const tx = await client.is_registered({ executor: executorPublicKey });
      return tx.result;
    });
  }

  async getExecutor(executorPublicKey: string): Promise<ExecutorInfo> {
    return withRetry(async () => {
      const client = await this.readOnlyClient();
      const tx = await client.get_executor({ executor: executorPublicKey });
      return unwrapResult(tx.result);
    });
  }
}
