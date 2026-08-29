// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ICredentialRegistry {
    function isCredentialActive(bytes32 credentialId) external view returns (bool);
}
