import { readFileSync } from 'fs';
import {
  Keypair,
  Operation,
  contract,
  scValToNative,
  Address,
} from '@stellar/stellar-sdk';
import { StellarConfig } from '../config/stellar';

function safeParseScVal(result: unknown): unknown {
  if (result == null) return null;
  try {
    return scValToNative(result as never);
  } catch {
    return result;
  }
}

export class EscrowDeployer {
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
        parseResultXdr: (result: unknown) => safeParseScVal(result) as Buffer,
      },
    );

    const sent = await tx.signAndSend({ force: true });
    const wasmHash = sent.result as Buffer | null;
    if (wasmHash == null) {
      throw new Error('uploadWasm returned empty result');
    }
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

  async invokeInitialize(
    contractId: string,
    token: string,
    releaseSigner: string,
    marketplace: string,
    admin: Keypair,
  ): Promise<unknown> {
    const { signTransaction, signAuthEntry } = contract.basicNodeSigner(
      admin,
      this.config.networkPassphrase,
    );

    const tokenAddr = Address.fromString(token).toScVal();
    const releaseAddr = Address.fromString(releaseSigner).toScVal();
    const mkpAddr = Address.fromString(marketplace).toScVal();

    const op = Operation.invokeContractFunction({
      contract: contractId,
      function: 'initialize',
      args: [tokenAddr, releaseAddr, mkpAddr],
    });

    const tx = await contract.AssembledTransaction.buildWithOp(op, {
      rpcUrl: this.config.rpcUrl,
      networkPassphrase: this.config.networkPassphrase,
      publicKey: admin.publicKey(),
      allowHttp: this.config.allowHttp,
      simulate: true,
      signTransaction,
      signAuthEntry,
      contractId,
      method: 'initialize',
      parseResultXdr: safeParseScVal,
    });

    const sent = await tx.signAndSend({ force: true });
    return sent.result;
  }

  async deploy(
    wasmPath: string,
    token: string,
    releaseSigner: string,
    marketplace: string,
    admin: Keypair,
  ): Promise<{ contractId: string; wasmHash: string; initResult: unknown }> {
    const wasmHash = await this.uploadWasm(wasmPath, admin);
    const contractId = await this.createContract(wasmHash, admin);
    const initResult = await this.invokeInitialize(contractId, token, releaseSigner, marketplace, admin);
    return { contractId, wasmHash, initResult };
  }
}
