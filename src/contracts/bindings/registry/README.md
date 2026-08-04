# registry Contract Bindings

TypeScript bindings for the registry Stellar smart contract.

## Installation

```bash
npm install
```

## Build

```bash
npm run build
```

## Usage

```typescript
import { Client } from "./src";

const client = new Client({
  contractId: "YOUR_CONTRACT_ID",
  rpcUrl: "https://soroban-testnet.stellar.org:443",
  networkPassphrase: "Test SDF Network ; September 2015",
});

// Call contract methods
// const result = await client.methodName();
```

## Generated Files

- `src/index.ts` - Entry point exporting the Client
- `src/types.ts` - Type definitions for contract structs, enums, and unions
- `src/contract.ts` - Client implementation
- `tsconfig.json` - TypeScript configuration
- `package.json` - NPM package configuration

This package was generated using the Js-Stellar-SDK contract binding generator.