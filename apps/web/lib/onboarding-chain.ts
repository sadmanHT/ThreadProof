import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";

export const FACTORY_ONBOARDING_DOMAIN = keccak256(
  toBytes("THREADPROOF_CHARTER_FACTORY_ONBOARDING_V1"),
);
const FACTORY_ORGANIZATION_ID_DOMAIN = "THREADPROOF_FACTORY_ORGANIZATION_V1";
const FACTORY_METADATA_DOMAIN = keccak256(
  toBytes("THREADPROOF_FACTORY_METADATA_V1"),
);

export type FactoryOnboardingDetails = {
  requestId: string;
  legalName: string;
  displayName: string;
  countryCode: string;
  notes: string;
  primaryAccount: Address;
};

export type FactoryOnboardingCommitments = {
  proposedChainOrganizationId: Hex;
  metadataHash: Hex;
  actionHash: Hex;
  signingMessage: string;
};

export function buildFactoryOnboardingCommitments(
  input: FactoryOnboardingDetails,
): FactoryOnboardingCommitments {
  const primaryAccount = getAddress(input.primaryAccount);
  const proposedChainOrganizationId = keccak256(
    toBytes(`${FACTORY_ORGANIZATION_ID_DOMAIN}:${input.requestId}`),
  );
  const metadataHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "string" },
      ],
      [
        FACTORY_METADATA_DOMAIN,
        input.requestId,
        input.legalName,
        input.displayName,
        input.countryCode,
        input.notes,
      ],
    ),
  );
  const actionHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [
        FACTORY_ONBOARDING_DOMAIN,
        proposedChainOrganizationId,
        primaryAccount,
        metadataHash,
      ],
    ),
  );
  const signingMessage = [
    "ThreadProof Factory Onboarding",
    `Request ID: ${input.requestId}`,
    `Organization ID: ${proposedChainOrganizationId}`,
    `Metadata hash: ${metadataHash}`,
    `Primary account: ${primaryAccount}`,
  ].join("\n");

  return {
    proposedChainOrganizationId,
    metadataHash,
    actionHash,
    signingMessage,
  };
}
