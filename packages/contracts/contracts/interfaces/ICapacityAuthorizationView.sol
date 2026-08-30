// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ICapacityAuthorizationView {
    struct CapacityState {
        uint256 activeCommitment;
        bytes32 capacityCredentialId;
        bytes32 policyHash;
        uint32 circuitVersion;
        uint64 updatedAt;
        bool active;
    }

    function getCapacityState(
        bytes32 factoryOrganizationId,
        bytes32 periodId,
        bytes32 processId
    ) external view returns (CapacityState memory);
}
