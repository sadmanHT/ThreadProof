// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IOrderRegistry {
    struct OrderState {
        bytes32 buyerOrganizationId;
        bytes32 primaryFactoryOrganizationId;
        uint32 currentVersion;
        bytes32 currentVersionHash;
        uint256 currentOrderCommitment;
        bytes32 currentPolicyHash;
        uint64 updatedAt;
        uint8 status;
    }

    function isCurrentOrderAuthorization(
        bytes32 orderId,
        bytes32 factoryOrganizationId,
        uint256 orderCommitment,
        bytes32 policyHash
    ) external view returns (bool);

    function getOrder(bytes32 orderId) external view returns (OrderState memory);
}
