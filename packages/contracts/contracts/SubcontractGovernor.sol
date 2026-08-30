// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ICapacityAuthorizationView} from "./interfaces/ICapacityAuthorizationView.sol";
import {ICredentialRegistry} from "./interfaces/ICredentialRegistry.sol";
import {IOrderRegistry} from "./interfaces/IOrderRegistry.sol";
import {IThreadProofRegistry} from "./interfaces/IThreadProofRegistry.sol";
import {ThreadProofEIP712} from "./utils/ThreadProofEIP712.sol";

/// @title SubcontractGovernor
/// @notice Canonical parent-child production authorization graph for ThreadProof.
/// @dev Stores commitments and identifiers only. It does not prove private allocation sums.
contract SubcontractGovernor is AccessControl, ThreadProofEIP712 {
    uint8 public constant FACTORY_ORGANIZATION_ROLE = 2;
    bytes32 public constant POLICY_ADMIN_ROLE = keccak256("POLICY_ADMIN_ROLE");

    bytes32 public constant SUBCONTRACT_AUTHORIZATION_TYPEHASH = keccak256(
        "SubcontractAuthorization(bytes32 parentOrderId,uint256 parentOrderCommitment,bytes32 parentAuthorizationId,bytes32 childAuthorizationId,bytes32 parentFactoryOrganizationId,bytes32 subcontractorFactoryOrganizationId,bytes32 policyHash,bytes32 capacityPeriodId,bytes32 capacityProcessId,uint256 capacityCommitment,bytes32 complianceCredentialId,uint256 nonce,uint64 deadline)"
    );

    struct PolicyRequirement {
        uint8 maxDepth;
        bytes32 credentialType;
        bool configured;
    }

    struct AuthorizationRequest {
        bytes32 parentOrderId;
        uint256 parentOrderCommitment;
        bytes32 parentAuthorizationId;
        bytes32 childAuthorizationId;
        bytes32 parentFactoryOrganizationId;
        bytes32 subcontractorFactoryOrganizationId;
        bytes32 policyHash;
        bytes32 capacityPeriodId;
        bytes32 capacityProcessId;
        uint256 capacityCommitment;
        bytes32 complianceCredentialId;
        uint256 nonce;
        uint64 deadline;
    }

    struct AuthorizationRecord {
        bytes32 rootOrderId;
        uint256 rootOrderCommitment;
        bytes32 parentOrderId;
        bytes32 parentAuthorizationId;
        bytes32 childAuthorizationId;
        bytes32 parentFactoryOrganizationId;
        bytes32 subcontractorFactoryOrganizationId;
        bytes32 policyHash;
        bytes32 capacityPeriodId;
        bytes32 capacityProcessId;
        uint256 capacityCommitment;
        bytes32 complianceCredentialId;
        uint8 depth;
        address approver;
        uint64 authorizedAt;
    }

    IOrderRegistry public immutable orderRegistry;
    IThreadProofRegistry public immutable organizationRegistry;
    ICredentialRegistry public immutable credentialRegistry;
    ICapacityAuthorizationView public immutable capacityVault;

    mapping(bytes32 policyHash => PolicyRequirement requirement) public policyRequirements;
    mapping(bytes32 childAuthorizationId => AuthorizationRecord record) private _authorizations;
    mapping(bytes32 parentFactoryOrganizationId => uint256 nextNonce) public nonces;

    error InvalidAddress();
    error InvalidIdentifier();
    error SignatureExpired(uint64 deadline);
    error PolicyNotConfigured(bytes32 policyHash);
    error DepthExceeded(uint8 supplied, uint8 maximum);
    error ChildAlreadyAuthorized(bytes32 childAuthorizationId);
    error InvalidParentAuthorization(bytes32 parentAuthorizationId);
    error ParentFactoryMismatch(bytes32 expected, bytes32 supplied);
    error ParentOrderMismatch(bytes32 expected, bytes32 supplied);
    error InvalidParentOrderAuthorization(bytes32 orderId);
    error InactiveSubcontractor(bytes32 organizationId);
    error InvalidSubcontractorRole(bytes32 organizationId);
    error InvalidComplianceCredential(bytes32 credentialId);
    error InvalidCapacityReference(bytes32 organizationId, bytes32 periodId, bytes32 processId);
    error CapacityPolicyMismatch(bytes32 expected, bytes32 supplied);
    error CapacityCommitmentMismatch(uint256 expected, uint256 supplied);
    error InvalidNonce(uint256 expected, uint256 supplied);
    error UnauthorizedParentFactorySigner(bytes32 organizationId, address signer);
    error CycleDetected(bytes32 childAuthorizationId);

    event PolicyRequirementConfigured(bytes32 indexed policyHash, uint8 maxDepth, bytes32 credentialType);
    event SubcontractAuthorized(
        bytes32 indexed childAuthorizationId,
        bytes32 indexed parentOrderId,
        bytes32 indexed subcontractorFactoryOrganizationId,
        bytes32 parentAuthorizationId,
        bytes32 parentFactoryOrganizationId,
        bytes32 rootOrderId,
        uint8 depth,
        bytes32 policyHash,
        bytes32 capacityPeriodId,
        bytes32 capacityProcessId,
        uint256 capacityCommitment,
        bytes32 complianceCredentialId,
        address approver
    );

    constructor(
        address initialAdmin,
        address orderRegistryAddress,
        address organizationRegistryAddress,
        address credentialRegistryAddress,
        address capacityVaultAddress
    ) ThreadProofEIP712("ThreadProof SubcontractGovernor", "1") {
        if (
            initialAdmin == address(0) ||
            orderRegistryAddress == address(0) ||
            organizationRegistryAddress == address(0) ||
            credentialRegistryAddress == address(0) ||
            capacityVaultAddress == address(0)
        ) revert InvalidAddress();

        orderRegistry = IOrderRegistry(orderRegistryAddress);
        organizationRegistry = IThreadProofRegistry(organizationRegistryAddress);
        credentialRegistry = ICredentialRegistry(credentialRegistryAddress);
        capacityVault = ICapacityAuthorizationView(capacityVaultAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(POLICY_ADMIN_ROLE, initialAdmin);
    }

    function configurePolicyRequirement(
        bytes32 policyHash,
        uint8 maxDepth,
        bytes32 credentialType
    ) external onlyRole(POLICY_ADMIN_ROLE) {
        if (policyHash == bytes32(0) || maxDepth == 0 || credentialType == bytes32(0)) revert InvalidIdentifier();
        policyRequirements[policyHash] = PolicyRequirement({
            maxDepth: maxDepth,
            credentialType: credentialType,
            configured: true
        });
        emit PolicyRequirementConfigured(policyHash, maxDepth, credentialType);
    }

    function authorizeSubcontract(
        AuthorizationRequest calldata request,
        bytes calldata parentFactorySignature
    ) external {
        if (
            request.parentOrderId == bytes32(0) ||
            request.childAuthorizationId == bytes32(0) ||
            request.parentFactoryOrganizationId == bytes32(0) ||
            request.subcontractorFactoryOrganizationId == bytes32(0) ||
            request.policyHash == bytes32(0)
        ) revert InvalidIdentifier();
        if (block.timestamp > request.deadline) revert SignatureExpired(request.deadline);
        if (_authorizations[request.childAuthorizationId].authorizedAt != 0) {
            revert ChildAlreadyAuthorized(request.childAuthorizationId);
        }

        PolicyRequirement memory requirement = policyRequirements[request.policyHash];
        if (!requirement.configured) revert PolicyNotConfigured(request.policyHash);

        (bytes32 rootOrderId, uint256 rootOrderCommitment, uint8 depth) = _validateParent(request);
        if (depth > requirement.maxDepth) revert DepthExceeded(depth, requirement.maxDepth);
        _requireCurrentRootAuthorization(rootOrderId, request.parentFactoryOrganizationId, rootOrderCommitment, request.policyHash, request.parentAuthorizationId);
        _validateSubcontractor(request.subcontractorFactoryOrganizationId);
        _validateCredential(request, requirement.credentialType);
        _validateCapacity(request);

        uint256 expectedNonce = nonces[request.parentFactoryOrganizationId];
        if (request.nonce != expectedNonce) revert InvalidNonce(expectedNonce, request.nonce);

        bytes32 structHash = keccak256(
            abi.encode(
                SUBCONTRACT_AUTHORIZATION_TYPEHASH,
                request.parentOrderId,
                request.parentOrderCommitment,
                request.parentAuthorizationId,
                request.childAuthorizationId,
                request.parentFactoryOrganizationId,
                request.subcontractorFactoryOrganizationId,
                request.policyHash,
                request.capacityPeriodId,
                request.capacityProcessId,
                request.capacityCommitment,
                request.complianceCredentialId,
                request.nonce,
                request.deadline
            )
        );
        address signer = _recoverTypedDataSigner(structHash, parentFactorySignature);
        if (organizationRegistry.organizationOfAccount(signer) != request.parentFactoryOrganizationId) {
            revert UnauthorizedParentFactorySigner(request.parentFactoryOrganizationId, signer);
        }

        _authorizations[request.childAuthorizationId] = AuthorizationRecord({
            rootOrderId: rootOrderId,
            rootOrderCommitment: rootOrderCommitment,
            parentOrderId: request.parentOrderId,
            parentAuthorizationId: request.parentAuthorizationId,
            childAuthorizationId: request.childAuthorizationId,
            parentFactoryOrganizationId: request.parentFactoryOrganizationId,
            subcontractorFactoryOrganizationId: request.subcontractorFactoryOrganizationId,
            policyHash: request.policyHash,
            capacityPeriodId: request.capacityPeriodId,
            capacityProcessId: request.capacityProcessId,
            capacityCommitment: request.capacityCommitment,
            complianceCredentialId: request.complianceCredentialId,
            depth: depth,
            approver: signer,
            authorizedAt: uint64(block.timestamp)
        });
        nonces[request.parentFactoryOrganizationId] = expectedNonce + 1;

        emit SubcontractAuthorized(
            request.childAuthorizationId,
            request.parentOrderId,
            request.subcontractorFactoryOrganizationId,
            request.parentAuthorizationId,
            request.parentFactoryOrganizationId,
            rootOrderId,
            depth,
            request.policyHash,
            request.capacityPeriodId,
            request.capacityProcessId,
            request.capacityCommitment,
            request.complianceCredentialId,
            signer
        );
    }

    function getAuthorization(bytes32 childAuthorizationId) external view returns (AuthorizationRecord memory) {
        AuthorizationRecord memory record = _authorizations[childAuthorizationId];
        if (record.authorizedAt == 0) revert InvalidParentAuthorization(childAuthorizationId);
        return record;
    }

    function isAuthorized(bytes32 childAuthorizationId) external view returns (bool) {
        return _authorizations[childAuthorizationId].authorizedAt != 0;
    }

    function complianceCredentialScopeHash(
        bytes32 subcontractorFactoryOrganizationId,
        bytes32 policyHash,
        bytes32 credentialType
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(subcontractorFactoryOrganizationId, policyHash, credentialType));
    }

    function hashAuthorization(AuthorizationRequest calldata request) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SUBCONTRACT_AUTHORIZATION_TYPEHASH,
                request.parentOrderId,
                request.parentOrderCommitment,
                request.parentAuthorizationId,
                request.childAuthorizationId,
                request.parentFactoryOrganizationId,
                request.subcontractorFactoryOrganizationId,
                request.policyHash,
                request.capacityPeriodId,
                request.capacityProcessId,
                request.capacityCommitment,
                request.complianceCredentialId,
                request.nonce,
                request.deadline
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function _validateParent(
        AuthorizationRequest calldata request
    ) internal view returns (bytes32 rootOrderId, uint256 rootOrderCommitment, uint8 depth) {
        if (request.parentAuthorizationId == bytes32(0)) {
            if (request.parentOrderId == request.childAuthorizationId) revert CycleDetected(request.childAuthorizationId);
            return (request.parentOrderId, request.parentOrderCommitment, 1);
        }

        AuthorizationRecord storage parent = _authorizations[request.parentAuthorizationId];
        if (parent.authorizedAt == 0) revert InvalidParentAuthorization(request.parentAuthorizationId);
        if (parent.childAuthorizationId == request.childAuthorizationId) revert CycleDetected(request.childAuthorizationId);
        if (parent.subcontractorFactoryOrganizationId != request.parentFactoryOrganizationId) {
            revert ParentFactoryMismatch(parent.subcontractorFactoryOrganizationId, request.parentFactoryOrganizationId);
        }
        if (parent.parentOrderId != request.parentOrderId) {
            revert ParentOrderMismatch(parent.parentOrderId, request.parentOrderId);
        }
        if (parent.policyHash != request.policyHash) revert CapacityPolicyMismatch(parent.policyHash, request.policyHash);
        return (parent.rootOrderId, parent.rootOrderCommitment, parent.depth + 1);
    }

    function _requireCurrentRootAuthorization(
        bytes32 rootOrderId,
        bytes32 currentParentFactoryId,
        uint256 rootOrderCommitment,
        bytes32 policyHash,
        bytes32 parentAuthorizationId
    ) internal view {
        bytes32 rootFactory = currentParentFactoryId;
        if (parentAuthorizationId != bytes32(0)) {
            AuthorizationRecord storage parent = _authorizations[parentAuthorizationId];
            bytes32 cursor = parentAuthorizationId;
            while (_authorizations[cursor].parentAuthorizationId != bytes32(0)) {
                cursor = _authorizations[cursor].parentAuthorizationId;
            }
            rootFactory = _authorizations[cursor].parentFactoryOrganizationId;
        }
        if (!orderRegistry.isCurrentOrderAuthorization(rootOrderId, rootFactory, rootOrderCommitment, policyHash)) {
            revert InvalidParentOrderAuthorization(rootOrderId);
        }
    }

    function _validateSubcontractor(bytes32 organizationId) internal view {
        if (!organizationRegistry.isActive(organizationId)) revert InactiveSubcontractor(organizationId);
        if (organizationRegistry.roleOf(organizationId) != FACTORY_ORGANIZATION_ROLE) {
            revert InvalidSubcontractorRole(organizationId);
        }
    }

    function _validateCredential(AuthorizationRequest calldata request, bytes32 credentialType) internal view {
        bytes32 scopeHash = complianceCredentialScopeHash(
            request.subcontractorFactoryOrganizationId,
            request.policyHash,
            credentialType
        );
        if (
            !credentialRegistry.isCredentialValidFor(
                request.complianceCredentialId,
                request.subcontractorFactoryOrganizationId,
                credentialType,
                scopeHash
            )
        ) revert InvalidComplianceCredential(request.complianceCredentialId);
    }

    function _validateCapacity(AuthorizationRequest calldata request) internal view {
        ICapacityAuthorizationView.CapacityState memory state;
        try capacityVault.getCapacityState(
            request.subcontractorFactoryOrganizationId,
            request.capacityPeriodId,
            request.capacityProcessId
        ) returns (ICapacityAuthorizationView.CapacityState memory capacityState) {
            state = capacityState;
        } catch {
            revert InvalidCapacityReference(
                request.subcontractorFactoryOrganizationId,
                request.capacityPeriodId,
                request.capacityProcessId
            );
        }
        if (!state.active) {
            revert InvalidCapacityReference(
                request.subcontractorFactoryOrganizationId,
                request.capacityPeriodId,
                request.capacityProcessId
            );
        }
        if (state.policyHash != request.policyHash) revert CapacityPolicyMismatch(state.policyHash, request.policyHash);
        if (state.activeCommitment != request.capacityCommitment) {
            revert CapacityCommitmentMismatch(state.activeCommitment, request.capacityCommitment);
        }
        if (!credentialRegistry.isCredentialActive(state.capacityCredentialId)) {
            revert InvalidCapacityReference(
                request.subcontractorFactoryOrganizationId,
                request.capacityPeriodId,
                request.capacityProcessId
            );
        }
    }
}
