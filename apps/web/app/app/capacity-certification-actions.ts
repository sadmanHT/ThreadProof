"use server";

import { type Address, type Hex } from "viem";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import type { Tables } from "@/lib/database.types";
import type { PreparedCapacityCertification } from "@/lib/capacity-certification-chain";
import {
  CAPACITY_CREDENTIAL_TYPE,
  CAPACITY_UINT64_MAX,
  CERTIFIER_ROLE,
  ISSUER_ROLE,
  ZERO_ADDRESS,
  capacityVaultCertificationAbi,
  computeCapacityCredentialDigest,
  computeCapacityScopeHash,
  computeCapacityStateKey,
  computeInitialCapacityCommitment,
  credentialRegistryCertificationAbi,
  encryptCapacityScalar,
  getCapacityCertificationNetwork,
  organizationRegistryCertificationAbi,
  randomCapacityFieldElement,
  randomCredentialId,
  requireCapacityHex32,
  semanticCapacityId,
} from "@/lib/capacity-certification.server";

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const prepareSchema = z.object({
  auditorOrganizationId: z.string().uuid(),
  factoryOrganizationId: z.string().uuid(),
  account: z.string().regex(addressPattern),
  exactCapacity: z.string().regex(/^[0-9]+$/),
  periodLabel: z.string().trim().min(1).max(80),
  processLabel: z.string().trim().min(1).max(80),
  policyHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  assessmentMethodology: z.string().trim().min(3).max(500),
  validFrom: z.string().regex(datePattern),
  validUntil: z.string().regex(datePattern),
  circuitVersion: z.coerce.number().int().positive().max(0xffffffff),
});

const resumeSchema = z.object({
  jobId: z.string().uuid(),
  account: z.string().regex(addressPattern),
});

type CertificationJob = Tables<"capacity_certification_jobs">;

export type CapacityCertificationResult =
  | { ok: true; prepared: PreparedCapacityCertification; credentialAlreadyOnChain: boolean }
  | { ok: false; error: string };

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected capacity certification error.";
}

function dateSeconds(date: string, endOfDay: boolean) {
  const suffix = endOfDay ? "T23:59:59.000Z" : "T00:00:00.000Z";
  const millis = new Date(`${date}${suffix}`).getTime();
  if (!Number.isFinite(millis)) throw new Error("Invalid credential validity date.");
  return BigInt(Math.floor(millis / 1000));
}

function preparedFromJob(
  job: CertificationJob,
  chainId: number,
  credentialRegistryAddress: Address,
  capacityVaultAddress: Address,
  factoryChainId: Hex,
): PreparedCapacityCertification {
  const periodId = requireCapacityHex32(job.chain_period_id, "Capacity period ID");
  const processId = requireCapacityHex32(job.chain_process_id, "Capacity process ID");
  const policyHash = requireCapacityHex32(job.policy_hash, "Policy hash");
  const credentialId = requireCapacityHex32(job.chain_credential_id, "Capacity credential ID");
  return {
    jobId: job.id,
    chainId,
    credentialRegistryAddress,
    capacityVaultAddress,
    credential: {
      credentialId,
      factoryOrganizationId: factoryChainId,
      credentialType: CAPACITY_CREDENTIAL_TYPE,
      digest: requireCapacityHex32(job.credential_digest, "Credential digest"),
      scopeHash: requireCapacityHex32(job.credential_scope_hash, "Credential scope hash"),
      validFrom: Math.floor(new Date(job.valid_from).getTime() / 1000).toString(),
      validUntil: Math.floor(new Date(job.valid_until).getTime() / 1000).toString(),
    },
    certification: {
      factoryOrganizationId: factoryChainId,
      periodId,
      processId,
      initialCommitment: job.capacity_commitment,
      capacityCredentialId: credentialId,
      policyHash,
      circuitVersion: job.circuit_version,
      stateKey: computeCapacityStateKey(factoryChainId, periodId, processId),
    },
  };
}

async function validateAuditorWallet(input: {
  account: Address;
  auditorChainId: Hex;
  circuitVersion: number;
}) {
  const network = getCapacityCertificationNetwork();
  const actualChainId = await network.client.getChainId();
  if (actualChainId !== network.configuredChainId) {
    throw new Error(`Besu chain ID ${actualChainId} does not match configured chain ID ${network.configuredChainId}.`);
  }

  const [mappedOrganization, activeAccount, issuer, certifier, verifier] = await Promise.all([
    network.client.readContract({
      address: network.organizationRegistryAddress,
      abi: organizationRegistryCertificationAbi,
      functionName: "organizationOfAccount",
      args: [input.account],
    }),
    network.client.readContract({
      address: network.organizationRegistryAddress,
      abi: organizationRegistryCertificationAbi,
      functionName: "isActiveAccount",
      args: [input.account],
    }),
    network.client.readContract({
      address: network.credentialRegistryAddress,
      abi: credentialRegistryCertificationAbi,
      functionName: "hasRole",
      args: [ISSUER_ROLE, input.account],
    }),
    network.client.readContract({
      address: network.capacityVaultAddress,
      abi: capacityVaultCertificationAbi,
      functionName: "hasRole",
      args: [CERTIFIER_ROLE, input.account],
    }),
    network.client.readContract({
      address: network.capacityVaultAddress,
      abi: capacityVaultCertificationAbi,
      functionName: "verifiers",
      args: [input.circuitVersion],
    }),
  ]);

  if (!activeAccount || mappedOrganization.toLowerCase() !== input.auditorChainId.toLowerCase()) {
    throw new Error("The connected wallet is not an active account for the selected auditor organization.");
  }
  if (!issuer) throw new Error("The connected auditor wallet does not hold CredentialRegistry ISSUER_ROLE.");
  if (!certifier) throw new Error("The connected auditor wallet does not hold CapacityVault CERTIFIER_ROLE.");
  if (verifier.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`No CapacitySpend verifier is registered for circuit version ${input.circuitVersion}.`);
  }

  return { network, actualChainId };
}

export async function prepareCapacityCertificationAction(input: unknown): Promise<CapacityCertificationResult> {
  try {
    const viewer = await requireConsortiumViewer();
    const parsed = prepareSchema.parse(input);
    const capacity = BigInt(parsed.exactCapacity);
    if (capacity <= 0n || capacity > CAPACITY_UINT64_MAX) {
      return { ok: false, error: "Certified capacity must be between 1 and 2^64-1." };
    }

    const validFrom = dateSeconds(parsed.validFrom, false);
    const validUntil = dateSeconds(parsed.validUntil, true);
    if (validUntil <= validFrom || validUntil <= BigInt(Math.floor(Date.now() / 1000))) {
      return { ok: false, error: "Credential validity must end in the future and after its start date." };
    }

    const membership = viewer.memberships.find((item) => item.organization_id === parsed.auditorOrganizationId);
    if (!membership || !hasOperationalRole(membership) || membership.organization.role !== "auditor" || membership.organization.status !== "active") {
      return { ok: false, error: "Active auditor operator or signer membership is required." };
    }

    const supabase = await createClient();
    const { data: factory, error: factoryError } = await supabase
      .from("organizations")
      .select("id,role,status,chain_organization_id")
      .eq("id", parsed.factoryOrganizationId)
      .maybeSingle();
    if (factoryError) throw factoryError;
    if (!factory || factory.role !== "factory" || factory.status !== "active") {
      return { ok: false, error: "The selected factory is not an active factory organization." };
    }

    const auditorChainId = requireCapacityHex32(membership.organization.chain_organization_id, "Auditor organization ID");
    const factoryChainId = requireCapacityHex32(factory.chain_organization_id, "Factory organization ID");
    const policyHash = requireCapacityHex32(parsed.policyHash.toLowerCase(), "Policy hash");
    const periodId = semanticCapacityId("period", parsed.periodLabel);
    const processId = semanticCapacityId("process", parsed.processLabel);
    const account = parsed.account as Address;

    const { network, actualChainId } = await validateAuditorWallet({
      account,
      auditorChainId,
      circuitVersion: parsed.circuitVersion,
    });

    const certificationTable = supabase.from("capacity_certification_jobs");
    const { data: existing, error: existingError } = await certificationTable
      .select("id,status,created_by")
      .eq("factory_organization_id", factory.id)
      .eq("chain_period_id", periodId)
      .eq("chain_process_id", processId)
      .not("status", "in", '("failed","stale")');
    if (existingError) throw existingError;

    const blocker = (existing ?? []).find((job) => job.status !== "prepared" || job.created_by !== viewer.userId);
    if (blocker) {
      return { ok: false, error: "This factory, period, and process already has certification work in progress." };
    }
    for (const old of existing ?? []) {
      const { error: deleteError } = await certificationTable.delete().eq("id", old.id);
      if (deleteError) throw deleteError;
    }

    const randomness = randomCapacityFieldElement();
    const commitment = await computeInitialCapacityCommitment(factoryChainId, periodId, processId, policyHash, capacity, randomness);
    const credentialId = randomCredentialId();
    const scopeHash = computeCapacityScopeHash(factoryChainId, periodId, processId, policyHash, commitment);
    const digest = computeCapacityCredentialDigest({
      credentialId,
      factoryOrganizationId: factoryChainId,
      auditorOrganizationId: auditorChainId,
      periodId,
      processId,
      policyHash,
      initialCommitment: commitment,
      scopeHash,
      methodology: parsed.assessmentMethodology,
      validFrom,
      validUntil,
      circuitVersion: parsed.circuitVersion,
    });

    const { data: inserted, error: insertError } = await certificationTable.insert({
      factory_organization_id: factory.id,
      auditor_organization_id: membership.organization_id,
      chain_credential_id: credentialId,
      chain_period_id: periodId,
      chain_process_id: processId,
      period_label: parsed.periodLabel,
      process_label: parsed.processLabel,
      policy_hash: policyHash,
      capacity_commitment: commitment.toString(),
      credential_scope_hash: scopeHash,
      credential_digest: digest,
      assessment_methodology: parsed.assessmentMethodology,
      valid_from: new Date(Number(validFrom) * 1000).toISOString(),
      valid_until: new Date(Number(validUntil) * 1000).toISOString(),
      circuit_version: parsed.circuitVersion,
      encrypted_capacity: encryptCapacityScalar(capacity),
      encrypted_randomness: encryptCapacityScalar(randomness),
      encryption_key_version: 1,
      status: "prepared",
      created_by: viewer.userId,
    }).select("*").single();
    if (insertError) throw insertError;

    return {
      ok: true,
      prepared: preparedFromJob(inserted, actualChainId, network.credentialRegistryAddress, network.capacityVaultAddress, factoryChainId),
      credentialAlreadyOnChain: false,
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function resumeCapacityCertificationAction(input: unknown): Promise<CapacityCertificationResult> {
  try {
    const viewer = await requireConsortiumViewer();
    const parsed = resumeSchema.parse(input);
    const supabase = await createClient();
    const { data: job, error: rowError } = await supabase.from("capacity_certification_jobs").select("*").eq("id", parsed.jobId).maybeSingle();
    if (rowError) throw rowError;
    if (!job || !["prepared", "credential_confirmed"].includes(job.status)) {
      return { ok: false, error: "This certification job cannot be resumed from its current state." };
    }

    const membership = viewer.memberships.find((item) => item.organization_id === job.auditor_organization_id);
    if (!membership || !hasOperationalRole(membership) || membership.organization.role !== "auditor" || membership.organization.status !== "active") {
      return { ok: false, error: "Active auditor operator or signer membership is required." };
    }

    const { data: factory, error: factoryError } = await supabase
      .from("organizations")
      .select("chain_organization_id,role,status")
      .eq("id", job.factory_organization_id)
      .maybeSingle();
    if (factoryError) throw factoryError;
    if (!factory || factory.role !== "factory" || factory.status !== "active") {
      return { ok: false, error: "The factory is no longer active." };
    }

    const auditorChainId = requireCapacityHex32(membership.organization.chain_organization_id, "Auditor organization ID");
    const factoryChainId = requireCapacityHex32(factory.chain_organization_id, "Factory organization ID");
    const account = parsed.account as Address;
    const { network, actualChainId } = await validateAuditorWallet({ account, auditorChainId, circuitVersion: job.circuit_version });
    const credentialId = requireCapacityHex32(job.chain_credential_id, "Capacity credential ID");

    const credentialAlreadyOnChain = await network.client.readContract({
      address: network.credentialRegistryAddress,
      abi: credentialRegistryCertificationAbi,
      functionName: "isCredentialActive",
      args: [credentialId],
    });

    if (credentialAlreadyOnChain) {
      const record = await network.client.readContract({
        address: network.credentialRegistryAddress,
        abi: credentialRegistryCertificationAbi,
        functionName: "getCredential",
        args: [credentialId],
      });
      if (
        record.subjectOrganizationId.toLowerCase() !== factoryChainId.toLowerCase() ||
        record.issuerOrganizationId.toLowerCase() !== auditorChainId.toLowerCase() ||
        record.credentialType.toLowerCase() !== CAPACITY_CREDENTIAL_TYPE.toLowerCase() ||
        record.digest.toLowerCase() !== job.credential_digest.toLowerCase() ||
        record.scopeHash.toLowerCase() !== job.credential_scope_hash.toLowerCase()
      ) {
        return { ok: false, error: "The on-chain credential does not match this staged certification job." };
      }
    } else if (job.status === "credential_confirmed") {
      return { ok: false, error: "The indexed capacity credential is no longer active on chain." };
    }

    return {
      ok: true,
      prepared: preparedFromJob(job, actualChainId, network.credentialRegistryAddress, network.capacityVaultAddress, factoryChainId),
      credentialAlreadyOnChain,
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
