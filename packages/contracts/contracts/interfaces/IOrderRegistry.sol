// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IOrderRegistry {
    function isCurrentOrderAuthorization(
        bytes32 orderId,
        bytes32 factoryOrganizationId,
        uint256 orderCommitment,
        bytes32 policyHash
    ) external view returns (bool);
}
