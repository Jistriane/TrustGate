import { defineConfig } from "@caatinga/core";

export default defineConfig({
  project: "trustgate",
  defaultNetwork: "local",
  contracts: {
    registry: {
      path: "./contracts/registry",
      wasm: "./contracts/registry/target/wasm32v1-none/release/registry.wasm",
    },
  },
  networks: {
    local: {
      rpcUrl: "http://localhost:8000/soroban/rpc",
      networkPassphrase: "Standalone Network ; February 2017",
    },
    testnet: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    },
  },
  frontend: {
    framework: "vite-react",
    bindingsOutput: "./src/contracts/bindings",
  },
});
