import { z } from "zod";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const commonSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  THREADPROOF_RPC_URL: z.string().url(),
  THREADPROOF_CHAIN_ID: z.coerce.number().int().positive().optional(),
  THREADPROOF_ORDER_REGISTRY_ADDRESS: address.optional(),
  THREADPROOF_CAPACITY_VAULT_ADDRESS: address.optional(),
  THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS: address.optional(),
  THREADPROOF_REGISTRY_ADDRESS: address.optional(),
  THREADPROOF_RELAYER_PRIVATE_KEY: privateKey.optional(),
});

const proofSchema = commonSchema.extend({
  THREADPROOF_CAPACITY_VAULT_ADDRESS: address,
  THREADPROOF_RELAYER_PRIVATE_KEY: privateKey.optional(),
  THREADPROOF_CAPACITY_WASM_PATH: z.string().min(1),
  THREADPROOF_CAPACITY_ZKEY_PATH: z.string().min(1),
  THREADPROOF_CAPACITY_VKEY_PATH: z.string().min(1).optional(),
  THREADPROOF_DATA_KEY_BASE64: z.string().min(20),
  THREADPROOF_FACTORY_SECRETS_JSON: z.string().min(2),
});

const indexerSchema = commonSchema.extend({
  THREADPROOF_REGISTRY_ADDRESS: address,
  THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS: address,
  THREADPROOF_ORDER_REGISTRY_ADDRESS: address,
  THREADPROOF_CAPACITY_VAULT_ADDRESS: address,
  THREADPROOF_INDEXER_START_BLOCK: z.coerce.bigint().nonnegative().default(0n),
  THREADPROOF_INDEXER_BLOCK_BATCH: z.coerce.bigint().positive().max(10_000n).default(1_000n),
});

const orderRelayerSchema = commonSchema.extend({
  THREADPROOF_REGISTRY_ADDRESS: address,
  THREADPROOF_ORDER_REGISTRY_ADDRESS: address,
  THREADPROOF_RELAYER_PRIVATE_KEY: privateKey,
});

export type CommonEnv = z.infer<typeof commonSchema>;
export type ProofEnv = z.infer<typeof proofSchema>;
export type IndexerEnv = z.infer<typeof indexerSchema>;
export type OrderRelayerEnv = z.infer<typeof orderRelayerSchema>;

export function getCommonEnv(): CommonEnv {
  return commonSchema.parse(process.env);
}

export function getProofEnv(): ProofEnv {
  return proofSchema.parse(process.env);
}

export function getIndexerEnv(): IndexerEnv {
  return indexerSchema.parse(process.env);
}

export function getOrderRelayerEnv(): OrderRelayerEnv {
  return orderRelayerSchema.parse(process.env);
}

export function parseFactorySecrets(raw: string) {
  const parsed = z.record(hex32, z.string().regex(/^[0-9]+$/)).parse(JSON.parse(raw));
  return new Map(Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), BigInt(value)]));
}
