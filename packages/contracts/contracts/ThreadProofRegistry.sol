// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ThreadProofRegistry
/// @notice Canonical consortium identity and organization-status registry.
/// @dev Governance contracts may hold REGISTRAR_ROLE/SUSPENDER_ROLE in production.
contract ThreadProofRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant SUSPENDER_ROLE = keccak256("SUSPENDER_ROLE");

    enum OrganizationRole {
        Unknown,
        Buyer,
        Factory,
        Auditor,
        Regulator,
        Industry,
        LaborRepresentative,
        Independent
    }

    enum OrganizationStatus {
        Unknown,
        Active,
        Suspended,
        Revoked
    }

    struct Organization {
        bytes32 id;
        address primaryAccount;
        OrganizationRole role;
        OrganizationStatus status;
        bytes32 metadataHash;
        uint64 createdAt;
        uint64 updatedAt;
    }

    mapping(bytes32 organizationId => Organization organization) private _organizations;
    mapping(address account => bytes32 organizationId) public organizationOfAccount;

    error InvalidOrganizationId();
    error InvalidAccount();
    error OrganizationAlreadyExists(bytes32 organizationId);
    error AccountAlreadyAssigned(address account);
    error UnknownOrganization(bytes32 organizationId);
    error InvalidRole();
    error InvalidStatus();

    event OrganizationRegistered(
        bytes32 indexed organizationId,
        address indexed primaryAccount,
        OrganizationRole role,
        bytes32 metadataHash
    );
    event OrganizationStatusChanged(
        bytes32 indexed organizationId,
        OrganizationStatus previousStatus,
        OrganizationStatus newStatus
    );
    event OrganizationPrimaryAccountRotated(
        bytes32 indexed organizationId,
        address indexed previousAccount,
        address indexed newAccount
    );
    event OrganizationMetadataUpdated(bytes32 indexed organizationId, bytes32 metadataHash);

    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) revert InvalidAccount();
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(REGISTRAR_ROLE, initialAdmin);
        _grantRole(SUSPENDER_ROLE, initialAdmin);
    }

    function registerOrganization(
        bytes32 organizationId,
        address primaryAccount,
        OrganizationRole organizationRole,
        bytes32 metadataHash
    ) external onlyRole(REGISTRAR_ROLE) {
        if (organizationId == bytes32(0)) revert InvalidOrganizationId();
        if (primaryAccount == address(0)) revert InvalidAccount();
        if (organizationRole == OrganizationRole.Unknown) revert InvalidRole();
        if (_organizations[organizationId].status != OrganizationStatus.Unknown) {
            revert OrganizationAlreadyExists(organizationId);
        }
        if (organizationOfAccount[primaryAccount] != bytes32(0)) {
            revert AccountAlreadyAssigned(primaryAccount);
        }

        uint64 nowTs = uint64(block.timestamp);
        _organizations[organizationId] = Organization({
            id: organizationId,
            primaryAccount: primaryAccount,
            role: organizationRole,
            status: OrganizationStatus.Active,
            metadataHash: metadataHash,
            createdAt: nowTs,
            updatedAt: nowTs
        });
        organizationOfAccount[primaryAccount] = organizationId;

        emit OrganizationRegistered(organizationId, primaryAccount, organizationRole, metadataHash);
    }

    function setOrganizationStatus(
        bytes32 organizationId,
        OrganizationStatus newStatus
    ) external onlyRole(SUSPENDER_ROLE) {
        Organization storage organization = _requireOrganization(organizationId);
        if (newStatus == OrganizationStatus.Unknown) revert InvalidStatus();

        OrganizationStatus previous = organization.status;
        organization.status = newStatus;
        organization.updatedAt = uint64(block.timestamp);
        emit OrganizationStatusChanged(organizationId, previous, newStatus);
    }

    /// @notice Rotates the transaction-signing account without rewriting organization history.
    /// @dev Intended to be called by an approved governance/recovery workflow.
    function rotatePrimaryAccount(
        bytes32 organizationId,
        address newAccount
    ) external onlyRole(REGISTRAR_ROLE) {
        if (newAccount == address(0)) revert InvalidAccount();
        if (organizationOfAccount[newAccount] != bytes32(0)) revert AccountAlreadyAssigned(newAccount);

        Organization storage organization = _requireOrganization(organizationId);
        address previousAccount = organization.primaryAccount;
        delete organizationOfAccount[previousAccount];
        organizationOfAccount[newAccount] = organizationId;
        organization.primaryAccount = newAccount;
        organization.updatedAt = uint64(block.timestamp);

        emit OrganizationPrimaryAccountRotated(organizationId, previousAccount, newAccount);
    }

    function updateMetadataHash(bytes32 organizationId, bytes32 metadataHash) external onlyRole(REGISTRAR_ROLE) {
        Organization storage organization = _requireOrganization(organizationId);
        organization.metadataHash = metadataHash;
        organization.updatedAt = uint64(block.timestamp);
        emit OrganizationMetadataUpdated(organizationId, metadataHash);
    }

    function getOrganization(bytes32 organizationId) external view returns (Organization memory) {
        Organization storage organization = _requireOrganization(organizationId);
        return organization;
    }

    function isActive(bytes32 organizationId) external view returns (bool) {
        return _organizations[organizationId].status == OrganizationStatus.Active;
    }

    function isActiveAccount(address account) external view returns (bool) {
        bytes32 organizationId = organizationOfAccount[account];
        return organizationId != bytes32(0) && _organizations[organizationId].status == OrganizationStatus.Active;
    }

    function _requireOrganization(bytes32 organizationId) internal view returns (Organization storage organization) {
        organization = _organizations[organizationId];
        if (organization.status == OrganizationStatus.Unknown) revert UnknownOrganization(organizationId);
    }
}
