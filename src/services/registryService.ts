import { Keypair, contract } from '@stellar/stellar-sdk';
import { StellarConfig } from '../config/stellar';
import { withRetry } from '../utils/retry';

export interface ExecutorInfo {
  metadata_uri: string;
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
  register_executor(args: {
    executor: string;
    metadata_uri: string;
  }): Promise<contract.AssembledTransaction<ContractResult<undefined>>>;
  is_registered(args: { executor: string }): Promise<contract.AssembledTransaction<boolean>>;
  get_executor(args: {
    executor: string;
  }): Promise<contract.AssembledTransaction<ContractResult<ExecutorInfo>>>;
}

type RegistryClient = contract.Client & RegistryContractMethods;

export interface RegistryServiceLike {
  registerExecutor(executor: Keypair, metadataUri: string): Promise<void>;
  isRegistered(executorPublicKey: string): Promise<boolean>;
  getExecutor(executorPublicKey: string): Promise<ExecutorInfo>;
}

export class RegistryService implements RegistryServiceLike {
  constructor(
    private readonly config: StellarConfig,
    private readonly contractId: string,
  ) {}

  private async readOnlyClient(): Promise<RegistryClient> {
    return contract.Client.from<RegistryContractMethods>({
      contractId: this.contractId,
      rpcUrl: this.config.rpcUrl,
      networkPassphrase: this.config.networkPassphrase,
      allowHttp: this.config.allowHttp,
    }) as Promise<RegistryClient>;
  }

  async registerExecutor(executor: Keypair, metadataUri: string): Promise<void> {
    await withRetry(async () => {
      const { signTransaction, signAuthEntry } = contract.basicNodeSigner(
        executor,
        this.config.networkPassphrase,
      );

      const client = (await contract.Client.from<RegistryContractMethods>({
        contractId: this.contractId,
        rpcUrl: this.config.rpcUrl,
        networkPassphrase: this.config.networkPassphrase,
        allowHttp: this.config.allowHttp,
        publicKey: executor.publicKey(),
        signTransaction,
        signAuthEntry,
      })) as RegistryClient;

      const tx = await client.register_executor({
        executor: executor.publicKey(),
        metadata_uri: metadataUri,
      });
      const sent = await tx.signAndSend();
      unwrapResult(sent.result);
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
