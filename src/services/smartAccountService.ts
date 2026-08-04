import { Keypair, contract } from '@stellar/stellar-sdk';
import { StellarConfig } from '../config/stellar';
import { buildDelegatedSigner } from '../config/smartAccount';

/**
 * Deploys OpenZeppelin smart-account instances (per-requester wallet
 * contracts). Uses `contract.Client.deploy` directly against a known,
 * already-deployed account contract WASM hash — the same pattern as
 * RegistryDeployer — rather than smart-account-kit's browser/WebAuthn-first
 * high-level API, since a requester here is a plain Ed25519 Stellar keypair,
 * not a passkey.
 */
export class SmartAccountService {
  constructor(
    private readonly config: StellarConfig,
    private readonly accountWasmHash: string,
  ) {}

  async deployForRequester(requester: Keypair): Promise<string> {
    const { signTransaction, signAuthEntry } = contract.basicNodeSigner(
      requester,
      this.config.networkPassphrase,
    );

    const deployTx = await contract.Client.deploy(
      { signers: [buildDelegatedSigner(requester.publicKey())] },
      {
        wasmHash: this.accountWasmHash,
        publicKey: requester.publicKey(),
        rpcUrl: this.config.rpcUrl,
        networkPassphrase: this.config.networkPassphrase,
        allowHttp: this.config.allowHttp,
        simulate: true,
        signTransaction,
        signAuthEntry,
      },
    );

    const sent = await deployTx.signAndSend({ force: true });
    const client = sent.result as contract.Client;
    return (client.options as { contractId: string }).contractId;
  }
}
