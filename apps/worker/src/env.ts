import { z } from "zod";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const deploymentEnvironment = z.enum(["development", "staging", "production"]).default("development");
const signerMode = z.enum(["disabled", "remote", "local-dev"]).default("disabled");

const commonSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  THREADPROOF_RPC_URL: z.string().url(),
  THREADPROOF_CHAIN_ID: z.coerce.number().int().positive().optional(),
  THREADPROOF_ORDER_REGISTRY_ADDRESS: address.optional(),
  THREADPROOF_CAPACITY_VAULT_ADDRESS: address.optional(),
  THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS: address.optional(),
  THREADPROOF_REGISTRY_ADDRESS: address.optional(),
  THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS: address.optional(),
  THREADPROOF_CHARTER_ADDRESS: address.optional(),
  THREADPROOF_DEPLOYMENT_ENV: deploymentEnvironment,
  THREADPROOF_SIGNER_MODE: signerMode,
  THREADPROOF_SIGNER_URL: z.string().url().optional(),
  THREADPROOF_RELAYER_ADDRESS: address.optional(),
  THREADPROOF_RELAYER_PRIVATE_KEY: privateKey.optional(),
});

type SignerConfig = z.infer<typeof commonSchema>;

function validateSignerConfig(value: SignerConfig, ctx: z.RefinementCtx, required: boolean) {
  const mode = value.THREADPROOF_SIGNER_MODE;

  if (required && mode === "disabled") {
    ctx.addIssue({ code: "custom", path: ["THREADPROOF_SIGNER_MODE"], message: "A transaction signer is required for this worker." });
    return;
  }

  if (value.THREADPROOF_DEPLOYMENT_ENV !== "development" && mode === "local-dev") {
    ctx.addIssue({ code: "custom", path: ["THREADPROOF_SIGNER_MODE"], message: "Raw private-key signing is development-only; staging and production must use the remote signer." });
  }

  if (mode === "remote") {
    if (!value.THREADPROOF_SIGNER_URL) {
      ctx.addIssue({ code: "custom", path: ["THREADPROOF_SIGNER_URL"], message: "Remote signer mode requires THREADPROOF_SIGNER_URL." });
    }
    if (!value.THREADPROOF_RELAYER_ADDRESS) {
      ctx.addIssue({ code: "custom", path: ["THREADPROOF_RELAYER_ADDRESS"], message: "Remote signer mode requires THREADPROOF_RELAYER_ADDRESS." });
    }
    if (value.THREADPROOF_RELAYER_PRIVATE_KEY) {
      ctx.addIssue({ code: "custom", path: ["THREADPROOF_RELAYER_PRIVATE_KEY"], message: "Remote signer mode forbids an in-process relayer private key." });
    }
  }

  if (mode === "local-dev") {
    if (!value.THREADPROOF_RELAYER_PRIVATE_KEY) {
      ctx.addIssue({ code: "custom", path: ["THREADPROOF_RELAYER_PRIVATE_KEY"], message: "Local development signer mode requires THREADPROOF_RELAYER_PRIVATE_KEY." });
    }
    if (value.THREADPROOF_SIGNER_URL) {
      ctx.addIssue({ code: "custom", path: ["THREADPROOF_SIGNER_URL"], message: "Local development signer mode must not use a remote signer URL." });
    }
  }

  if (mode === "disabled" && value.THREADPROOF_RELAYER_PRIVATE_KEY) {
    ctx.addIssue({ code: "custom", path: ["THREADPROOF_RELAYER_PRIVATE_KEY"], message: "A relayer private key cannot be configured while transaction signing is disabled." });
  }

  if (value.THREADPROOF_DEPLOYMENT_ENV === "production" && value.THREADPROOF_RELAYER_PRIVATE_KEY) {
    ctx.addIssue({ code: "custom", path: ["THREADPROOF_RELAYER_PRIVATE_KEY"], message: "Production workers must never receive a raw relayer private key." });
  }
}

const proofSchema = commonSchema.extend({
  THREADPROOF_CAPACITY_VAULT_ADDRESS: address,
  THREADPROOF_CAPACITY_WASM_PATH: z.string().min(1),
  THREADPROOF_CAPACITY_ZKEY_PATH: z.string().min(1),
  THREADPROOF_CAPACITY_VKEY_PATH: z.string().min(1).optional(),
  THREADPROOF_DATA_KEY_BASE64: z.string().min(20),
  THREADPROOF_FACTORY_SECRETS_JSON: z.string().min(2),
}).superRefine((value, ctx) => {
  validateSignerConfig(value, ctx, false);
  if (value.THREADPROOF_SIGNER_MODE !== "disabled") {
    ctx.addIssue({
      code: "custom",
      path: ["THREADPROOF_SIGNER_MODE"],
      message: "The proof generator must have transaction signing disabled; use the dedicated proof submitter for chain writes.",
    });
  }
});

const proofSubmitterSchema = commonSchema.extend({
  THREADPROOF_CAPACITY_VAULT_ADDRESS: address,
}).superRefine((value, ctx) => validateSignerConfig(value, ctx, true));

const indexerSchema = commonSchema.extend({
  THREADPROOF_REGISTRY_ADDRESS: address,
  THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS: address,
  THREADPROOF_ORDER_REGISTRY_ADDRESS: address,
  THREADPROOF_CAPACITY_VAULT_ADDRESS: address,
  THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS: address,
  THREADPROOF_CHARTER_ADDRESS: address,
  THREADPROOF_INDEXER_START_BLOCK: z.coerce.bigint().nonnegative().default(0n),
  THREADPROOF_INDEXER_BLOCK_BATCH: z.coerce.bigint().positive().max(10_000n).default(1_000n),
});

const orderRelayerSchema = commonSchema.extend({
  THREADPROOF_REGISTRY_ADDRESS: address,
  THREADPROOF_ORDER_REGISTRY_ADDRESS: address,
}).superRefine((value, ctx) => validateSignerConfig(value, ctx, true));

export type CommonEnv = z.infer<typeof commonSchema>;
export type ProofEnv = z.infer<typeof proofSchema>;
export type ProofSubmitterEnv = z.infer<typeof proofSubmitterSchema>;
export type IndexerEnv = z.infer<typeof indexerSchema>;
export type OrderRelayerEnv = z.infer<typeof orderRelayerSchema>;

export function getCommonEnv(): CommonEnv {
  return commonSchema.parse(process.env);
}

export function getProofEnv(): ProofEnv {
  return proofSchema.parse(process.env);
}

export function getProofSubmitterEnv(): ProofSubmitterEnv {
  return proofSubmitterSchema.parse(process.env);
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
