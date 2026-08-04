import { readFileSync } from 'fs';
import { Keypair, Operation, contract, scValToNative } from '@stellar/stellar-sdk';
import { StellarConfig } from '../config/stellar';

export class RegistryDeployer {
  constructor(private readonly config: StellarConfig) {}

  async uploadWasm(wasmPath: string, admin: Keypair): Promise<string> {
    const wasm = readFileSync(wasmPath);
    const { signTransaction } = contract.basicNodeSigner(admin, this.config.networkPassphrase);

    const tx = await contract.AssembledTransaction.buildWithOp(
      Operation.uploadContractWasm({ wasm }),
      {
        rpcUrl: this.config.rpcUrl,
        networkPassphrase: this.config.networkPassphrase,
        publicKey: admin.publicKey(),
        allowHttp: this.config.allowHttp,
        simulate: true,
        signTransaction,
        contractId: 'ignored',
        method: 'upload_contract_wasm',
        parseResultXdr: (result: unknown) => scValToNative(result as never) as Buffer,
      },
    );

    const sent = await tx.signAndSend({ force: true });
    const wasmHash = sent.result as Buffer;
    return wasmHash.toString('hex');
  }

  async createContract(wasmHash: string, admin: Keypair): Promise<string> {
    const { signTransaction, signAuthEntry } = contract.basicNodeSigner(
      admin,
      this.config.networkPassphrase,
    );

    const tx = await contract.Client.deploy(null, {
      wasmHash,
      publicKey: admin.publicKey(),
      rpcUrl: this.config.rpcUrl,
      networkPassphrase: this.config.networkPassphrase,
      allowHttp: this.config.allowHttp,
      simulate: true,
      signTransaction,
      signAuthEntry,
    });

    const sent = await tx.signAndSend();
    const client = sent.result as InstanceType<typeof contract.Client>;
    return (client.options as { contractId: string }).contractId;
  }

  async deploy(wasmPath: string, admin: Keypair): Promise<string> {
    const wasmHash = await this.uploadWasm(wasmPath, admin);
    return this.createContract(wasmHash, admin);
  }
}
