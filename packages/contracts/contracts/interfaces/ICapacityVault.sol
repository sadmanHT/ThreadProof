// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Narrow read interface used by SubcontractGovernor to verify canonical PoFC allocations.
interface ICapacityVault {
    struct CapacityAllocation {
        bytes32 stateKey;
        bytes32 orderId;
        bytes32 factoryOrganizationId;
        bytes32 periodId;
        bytes32 processId;
        bytes32 capacityCredentialId;
        uint256 orderCommitment;
        bytes32 policyHash;
        uint256 nullifier;
        uint32 circuitVersion;
        uint64 authorizedAt;
        bool exists;
    }

    function getCapacityAllocation(bytes32 allocationId) external view returns (CapacityAllocation memory);

    function isCapacityAllocationAuthorized(
        bytes32 allocationId,
        bytes32 orderId,
        bytes32 factoryOrganizationId,
        bytes32 periodId,
        bytes32 processId,
        uint256 orderCommitment,
        bytes32 policyHash
    ) external view returns (bool);
}
