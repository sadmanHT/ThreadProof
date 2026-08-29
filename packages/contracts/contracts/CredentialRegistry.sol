// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IThreadProofRegistry} from "./interfaces/IThreadProofRegistry.sol";

/// @title CredentialRegistry
/// @notice Shared status and integrity registry for ThreadProof verifiable credentials.
contract CredentialRegistry is AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant SUSPENDER_ROLE = keccak256("SUSPENDER_ROLE");

    enum CredentialStatus {
        Unknown,
        Active,
        Suspended,
        Revoked
    }

    struct CredentialRecord {
        bytes32 credentialId;
        bytes32 subjectOrganizationId;
        bytes32 issuerOrganizationId;
        bytes32 credentialType;
        bytes32 digest;
        bytes32 scopeHash;
        uint64 validFrom;
        uint64 validUntil;
        CredentialStatus status;
    }

    IThreadProofRegistry public immutable organizationRegistry;
    mapping(bytes32 credentialId => CredentialRecord record) private _credentials;

    error InvalidAddress();
    error InvalidCredentialId();
    error CredentialAlreadyExists(bytes32 credentialId);
    error UnknownCredential(bytes32 credentialId);
    error InvalidValidityWindow();
    error InactiveIssuer(bytes32 issuerOrganizationId);
    error InactiveSubject(bytes32 subjectOrganizationId);
    error UnauthorizedIssuer(bytes32 credentialId);
    error InvalidStatus();

    event CredentialIssued(
        bytes32 indexed credentialId,
        bytes32 indexed subjectOrganizationId,
        bytes32 indexed issuerOrganizationId,
        bytes32 credentialType,
        uint64 validFrom,
        uint64 validUntil,
        bytes32 digest,
        bytes32 scopeHash
    );
    event CredentialStatusChanged(
        bytes32 indexed credentialId,
        CredentialStatus previousStatus,
        CredentialStatus newStatus
    );

    constructor(address initialAdmin, address organizationRegistryAddress) {
        if (initialAdmin == address(0) || organizationRegistryAddress == address(0)) revert InvalidAddress();
        organizationRegistry = IThreadProofRegistry(organizationRegistryAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(SUSPENDER_ROLE, initialAdmin);
    }

    function issueCredential(
        bytes32 credentialId,
        bytes32 subjectOrganizationId,
        bytes32 credentialType,
        bytes32 digest,
        bytes32 scopeHash,
        uint64 validFrom,
        uint64 validUntil
    ) external onlyRole(ISSUER_ROLE) {
        if (credentialId == bytes32(0)) revert InvalidCredentialId();
        if (_credentials[credentialId].status != CredentialStatus.Unknown) revert CredentialAlreadyExists(credentialId);
        if (validUntil <= validFrom) revert InvalidValidityWindow();
        if (!organizationRegistry.isActive(subjectOrganizationId)) revert InactiveSubject(subjectOrganizationId);

        bytes32 issuerOrganizationId = organizationRegistry.organizationOfAccount(msg.sender);
        if (issuerOrganizationId == bytes32(0) || !organizationRegistry.isActive(issuerOrganizationId)) {
            revert InactiveIssuer(issuerOrganizationId);
        }

        _credentials[credentialId] = CredentialRecord({
            credentialId: credentialId,
            subjectOrganizationId: subjectOrganizationId,
            issuerOrganizationId: issuerOrganizationId,
            credentialType: credentialType,
            digest: digest,
            scopeHash: scopeHash,
            validFrom: validFrom,
            validUntil: validUntil,
            status: CredentialStatus.Active
        });

        emit CredentialIssued(
            credentialId,
            subjectOrganizationId,
            issuerOrganizationId,
            credentialType,
            validFrom,
            validUntil,
            digest,
            scopeHash
        );
    }

    function revokeCredential(bytes32 credentialId) external {
        CredentialRecord storage record = _requireCredential(credentialId);
        bytes32 callerOrganizationId = organizationRegistry.organizationOfAccount(msg.sender);
        if (record.issuerOrganizationId != callerOrganizationId && !hasRole(SUSPENDER_ROLE, msg.sender)) {
            revert UnauthorizedIssuer(credentialId);
        }
        _setStatus(record, CredentialStatus.Revoked);
    }

    function setCredentialStatus(
        bytes32 credentialId,
        CredentialStatus newStatus
    ) external onlyRole(SUSPENDER_ROLE) {
        if (newStatus == CredentialStatus.Unknown) revert InvalidStatus();
        CredentialRecord storage record = _requireCredential(credentialId);
        _setStatus(record, newStatus);
    }

    function getCredential(bytes32 credentialId) external view returns (CredentialRecord memory) {
        CredentialRecord storage record = _requireCredential(credentialId);
        return record;
    }

    function isCredentialActive(bytes32 credentialId) public view returns (bool) {
        return _isRecordActive(_credentials[credentialId]);
    }

    /// @notice Checks that a currently usable credential is bound to the exact subject, type and scope required.
    /// @dev Used by protocol contracts so a valid credential for one factory/process cannot authorize another.
    function isCredentialValidFor(
        bytes32 credentialId,
        bytes32 subjectOrganizationId,
        bytes32 credentialType,
        bytes32 scopeHash
    ) external view returns (bool) {
        CredentialRecord storage record = _credentials[credentialId];
        return
            _isRecordActive(record) &&
            record.subjectOrganizationId == subjectOrganizationId &&
            record.credentialType == credentialType &&
            record.scopeHash == scopeHash;
    }

    function _isRecordActive(CredentialRecord storage record) internal view returns (bool) {
        if (record.status != CredentialStatus.Active) return false;
        if (block.timestamp < record.validFrom || block.timestamp > record.validUntil) return false;
        if (!organizationRegistry.isActive(record.issuerOrganizationId)) return false;
        return true;
    }

    function _setStatus(CredentialRecord storage record, CredentialStatus newStatus) internal {
        CredentialStatus previous = record.status;
        record.status = newStatus;
        emit CredentialStatusChanged(record.credentialId, previous, newStatus);
    }

    function _requireCredential(bytes32 credentialId) internal view returns (CredentialRecord storage record) {
        record = _credentials[credentialId];
        if (record.status == CredentialStatus.Unknown) revert UnknownCredential(credentialId);
    }
}
