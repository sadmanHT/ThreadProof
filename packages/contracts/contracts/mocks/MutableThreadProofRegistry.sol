// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Test-only mutable registry used to exercise protocol defense-in-depth against role drift.
contract MutableThreadProofRegistry {
    mapping(address account => bytes32 organizationId) public organizationOfAccount;
    mapping(bytes32 organizationId => bool active) private _active;
    mapping(bytes32 organizationId => uint8 role) private _roles;

    function setOrganization(bytes32 organizationId, address account, uint8 role, bool active) external {
        organizationOfAccount[account] = organizationId;
        _roles[organizationId] = role;
        _active[organizationId] = active;
    }

    function setRole(bytes32 organizationId, uint8 role) external {
        _roles[organizationId] = role;
    }

    function setActive(bytes32 organizationId, bool active) external {
        _active[organizationId] = active;
    }

    function isActive(bytes32 organizationId) external view returns (bool) {
        return _active[organizationId];
    }

    function roleOf(bytes32 organizationId) external view returns (uint8) {
        return _roles[organizationId];
    }
}
