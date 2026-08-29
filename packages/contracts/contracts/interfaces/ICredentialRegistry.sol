// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ICredentialRegistry {
    function isCredentialActive(bytes32 credentialId) external view returns (bool);

    function isCredentialValidFor(
        bytes32 credentialId,
        bytes32 subjectOrganizationId,
        bytes32 credentialType,
        bytes32 scopeHash
    ) external view returns (bool);
}
