import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 500 },
      viaIR: true,
    },
  },
  networks: {
    threadproofLocal: {
      url: process.env.THREADPROOF_RPC_URL ?? "http://127.0.0.1:8545",
      chainId: Number(process.env.THREADPROOF_CHAIN_ID ?? 2026),
      accounts: process.env.DEV_DEPLOYER_PRIVATE_KEY ? [process.env.DEV_DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;
