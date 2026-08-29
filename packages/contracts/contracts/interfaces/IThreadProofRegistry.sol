// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IThreadProofRegistry {
    function organizationOfAccount(address account) external view returns (bytes32 organizationId);
    function isActive(bytes32 organizationId) external view returns (bool);
    function roleOf(bytes32 organizationId) external view returns (uint8);
}
