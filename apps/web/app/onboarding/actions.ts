"use server";

import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { requireViewer } from "@/lib/viewer";
import { createServiceClient } from "@/lib/supabase/service.server";
import { buildFactoryOnboardingCommitments } from "@/lib/onboarding-chain";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);

const onboardingSchema = z.object({
  requestId: z.string().uuid(),
  legalName: z.string().trim().min(2).max(180),
  displayName: z.string().trim().min(2).max(100),
  countryCode: z.string().trim().toUpperCase().length(2).or(z.literal("")),
  notes: z.string().trim().max(1000).default(""),
  primaryAccount: address,
  walletSignature: signature,
});

export type SubmitFactoryOnboardingInput = z.input<typeof onboardingSchema>;
export type SubmitFactoryOnboardingResult =
  | { ok: true }
  | { ok: false; error: string };

export async function submitOnboardingRequest(
  input: SubmitFactoryOnboardingInput,
): Promise<SubmitFactoryOnboardingResult> {
  const viewer = await requireViewer();
  if (viewer.isConsortiumMember) return { ok: false, error: "This account is already a consortium member." };

  const parsed = onboardingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the factory details and wallet signature, then try again." };

  const primaryAccount = getAddress(parsed.data.primaryAccount) as Address;
  const details = {
    requestId: parsed.data.requestId,
    legalName: parsed.data.legalName,
    displayName: parsed.data.displayName,
    countryCode: parsed.data.countryCode,
    notes: parsed.data.notes,
    primaryAccount,
  };
  const commitments = buildFactoryOnboardingCommitments(details);

  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: commitments.signingMessage,
      signature: parsed.data.walletSignature as Hex,
    });
  } catch {
    return { ok: false, error: "The factory wallet proof could not be verified." };
  }
  if (getAddress(recovered) !== primaryAccount) {
    return { ok: false, error: "The signature does not belong to the proposed factory primary account." };
  }

  const supabase = createServiceClient();
  const { data: existing, error: existingError } = await supabase
    .from("organization_onboarding_requests")
    .select("id")
    .eq("requested_by", viewer.userId)
    .eq("status", "pending")
    .maybeSingle();
  if (existingError) return { ok: false, error: existingError.message };
  if (existing) return { ok: false, error: "A factory onboarding request is already pending." };

  const { error } = await supabase.from("organization_onboarding_requests").insert({
    id: parsed.data.requestId,
    requested_by: viewer.userId,
    legal_name: parsed.data.legalName,
    display_name: parsed.data.displayName,
    requested_role: "factory",
    country_code: parsed.data.countryCode || null,
    notes: parsed.data.notes || null,
    status: "pending",
    primary_account: primaryAccount,
    wallet_signature: parsed.data.walletSignature,
    proposed_chain_organization_id: commitments.proposedChainOrganizationId,
    metadata_hash: commitments.metadataHash,
    action_hash: commitments.actionHash,
  });
  if (error) return { ok: false, error: error.message };

  return { ok: true };
}
