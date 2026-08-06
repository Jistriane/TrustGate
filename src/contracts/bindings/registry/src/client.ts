import {ExecutorInfo, RegistryError} from './types.js';
import {Result, Spec, AssembledTransaction, Client as ContractClient, ClientOptions as ContractClientOptions, MethodOptions} from '@stellar/stellar-sdk/contract';
import {Address} from '@stellar/stellar-sdk';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Client {
  get_executor({ executor }: { executor: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<Result<ExecutorInfo, RegistryError>>>;
  is_registered({ executor }: { executor: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<boolean>>;
  register_executor({ executor, metadata_uri }: { executor: string | Address; metadata_uri: string }, options?: MethodOptions): Promise<AssembledTransaction<Result<[], RegistryError>>>;
  update_executor({ executor, profile_uri }: { executor: string | Address; profile_uri: string }, options?: MethodOptions): Promise<AssembledTransaction<Result<[], RegistryError>>>;
  unregister_executor({ executor }: { executor: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<Result<[], RegistryError>>>;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see above
export class Client extends ContractClient {
  constructor(public readonly options: ContractClientOptions) {
    super(
      new Spec([
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAQAAAAEAAAAAAAAACEV4ZWN1dG9yAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAMZ2V0X2V4ZWN1dG9yAAAAAQAAAAAAAAAIZXhlY3V0b3IAAAATAAAAAQAAA+kAAAfQAAAADEV4ZWN1dG9ySW5mbwAAB9AAAAANUmVnaXN0cnlFcnJvcgAAAA==",
        "AAAAAAAAAAAAAAANaXNfcmVnaXN0ZXJlZAAAAAAAAAEAAAAAAAAACGV4ZWN1dG9yAAAAEwAAAAEAAAAB",
        "AAAAAQAAAAAAAAAAAAAADEV4ZWN1dG9ySW5mbwAAAAIAAAAAAAAAD3Byb2ZpbGVfdXJpAAAAABAAAAAAAAAAFnVwZGF0ZWRfYXRfbGVkZ2VyAAAAAAAAAwAAAAAAAAAScmVnaXN0ZXJlZF9hdF9sZWRnZXIAAAAD",
        "AAAABAAAAAAAAAAAAAAADVJlZ2lzdHJ5RXJyb3IAAAAAAAAMAAAAAAAAABFBbHJlYWR5UmVnaXN0ZXJlZAAAAAAAAAEAAAAAAAAADU5vdFJlZ2lzdGVyZWQAAAAAAAACAAAAAAAAABFQcm9maWxlVXJpRW1wdHkAAAAAAwAAAAAAAAASUHJvZmlsZVVyaVRvb0xvbmcAAAAE",
        "AAAAAAAAAAAAAAARcmVnaXN0ZXJfZXhlY3V0b3IAAAAAAAACAAAAAAAAAAhleGVjdXRvcgAAABMAAAAAAAAADG1ldGFkYXRhX3VyaQAAABAAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1SZWdpc3RyeUVycm9yAAAA",
        "AAAAAAAAAAAAAAAQdXBkYXRlX2V4ZWN1dG9yAAAAAAAAAgAAAAAAAAAIZXhlY3V0b3IAAAATAAAAAAAAAAtwcm9maWxlX3VyaQAAABAAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1SZWdpc3RyeUVycm9yAAAA",
        "AAAAAAAAAAAAAAAidW5yZWdpc3Rlcl9leGVjdXRvcgAAAAAAAQAAAAAAAAAIZXhlY3V0b3IAAAATAAAAAQAAA+gAAAHQAAAADVJlZ2lzdHJ5RXJyb3IAAAA",
      ]),
      options
    );
  }

   static deploy<T = Client>(options: MethodOptions & Omit<ContractClientOptions, 'contractId'> & { wasmHash: Buffer | string; salt?: Buffer | Uint8Array; format?: "hex" | "base64"; address?: string; }): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options);
  }
  public readonly fromJSON = {
    get_executor: this.txFromJSON<Result<ExecutorInfo, RegistryError>>,
    is_registered: this.txFromJSON<boolean>,
    register_executor: this.txFromJSON<Result<[], RegistryError>>,
    update_executor: this.txFromJSON<Result<[], RegistryError>>,
    unregister_executor: this.txFromJSON<Result<[], RegistryError>>,
  };

}