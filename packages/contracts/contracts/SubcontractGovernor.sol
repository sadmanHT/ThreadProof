// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ICapacityVault} from "./interfaces/ICapacityVault.sol";
import {ICredentialRegistry} from "./interfaces/ICredentialRegistry.sol";
import {IOrderRegistry} from "./interfaces/IOrderRegistry.sol";
import {IThreadProofRegistry} from "./interfaces/IThreadProofRegistry.sol";
import {ThreadProofEIP712} from "./utils/ThreadProofEIP712.sol";

/// @title SubcontractGovernor
/// @notice Canonical parent-child authorization chain for compliant subcontract production.
/// @dev Stores authorization IDs/commitments only. Exact allocation quantities and commercial terms remain private.
contract SubcontractGovernor is AccessControl, Pausable, ThreadProofEIP712 {
    uint8 public constant FACTORY_ORGANIZATION_ROLE = 2;
    uint8 public constant ORDER_STATUS_ACTIVE = 1;
    uint8 public constant HARD_MAX_DEPTH = 8;

    bytes32 public constant POLICY_ADMIN_ROLE = keccak256("POLICY_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant COMPLIANCE_SCOPE_DOMAIN = keccak256("THREADPROOF_SUBCONTRACT_COMPLIANCE_V1");
    bytes32 public constant PROCESS_SCOPE_DOMAIN = keccak256("THREADPROOF_SUBCONTRACT_PROCESS_V1");

    bytes32 public constant SUBCONTRACT_AUTHORIZATION_TYPEHASH = keccak256(
        "SubcontractAuthorization(bytes32 parentOrderId,bytes32 childOrderId,bytes32 parentFactoryOrganizationId,bytes32 subcontractorOrganizationId,bytes32 periodId,bytes32 processId,bytes32 policyHash,bytes32 parentVersionHash,bytes32 childVersionHash,bytes32 complianceCredentialId,bytes32 processCredentialId,bytes32 capacityAllocationId,uint32 sequence,uint256 nonce,uint64 deadline)"
    );

    struct SubcontractPolicy {
        uint8 maxDepth;
        bytes32 complianceCredentialType;
        bytes32 processCredentialType;
        bool exists;
    }

    struct SubcontractAuthorization {
        bytes32 parentOrderId;
        bytes32 childOrderId;
        bytes32 parentFactoryOrganizationId;
        bytes32 subcontractorOrganizationId;
        bytes32 periodId;
        bytes32 processId;
        bytes32 policyHash;
        bytes32 parentVersionHash;
        bytes32 childVersionHash;
        bytes32 complianceCredentialId;
        bytes32 processCredentialId;
        bytes32 capacityAllocationId;
        uint32 sequence;
        uint256 nonce;
        uint64 deadline;
    }

    struct SubcontractRecord {
        bytes32 parentOrderId;
        bytes32 childOrderId;
        bytes32 buyerOrganizationId;
        bytes32 parentFactoryOrganizationId;
        bytes32 subcontractorOrganizationId;
        bytes32 periodId;
        bytes32 processId;
        bytes32 policyHash;
        bytes32 parentVersionHash;
        bytes32 childVersionHash;
        bytes32 complianceCredentialId;
        bytes32 processCredentialId;
        bytes32 capacityAllocationId;
        bytes32 capacityStateKey;
        uint256 childOrderCommitment;
        uint256 capacityNullifier;
        uint32 sequence;
        uint8 depth;
        address parentSigner;
        uint64 authorizedAt;
        bool exists;
    }

    IThreadProofRegistry public immutable organizationRegistry;
    ICredentialRegistry public immutable credentialRegistry;
    IOrderRegistry public immutable orderRegistry;
    ICapacityVault public immutable capacityVault;

    mapping(bytes32 policyHash => SubcontractPolicy policy) private _policies;
    mapping(bytes32 childOrderId => SubcontractRecord record) private _subcontracts;
    mapping(bytes32 parentFactoryOrganizationId => uint256 nextNonce) public nonces;

    error InvalidAddress();
    error InvalidIdentifier();
    error InvalidPolicy();
    error PolicyAlreadyRegistered(bytes32 policyHash);
    error UnknownPolicy(bytes32 policyHash);
    error SignatureExpired(uint64 deadline);
    error UnknownParentOrder(bytes32 orderId);
    error UnknownChildOrder(bytes32 orderId);
    error InactiveParentOrder(bytes32 orderId);
    error InactiveChildOrder(bytes32 orderId);
    error BuyerMismatch(bytes32 parentBuyer, bytes32 childBuyer);
    error ParentFactoryMismatch(bytes32 expected, bytes32 supplied);
    error ChildFactoryMismatch(bytes32 expected, bytes32 supplied);
    error InactiveFactory(bytes32 factoryOrganizationId);
    error InvalidFactoryRole(bytes32 factoryOrganizationId);
    error ParentVersionMismatch(bytes32 expected, bytes32 supplied);
    error ChildVersionMismatch(bytes32 expected, bytes32 supplied);
    error PolicyMismatch(bytes32 expected, bytes32 supplied);
    error InvalidParentOrderAuthorization(bytes32 orderId);
    error InvalidChildOrderAuthorization(bytes32 orderId);
    error InvalidComplianceCredential(bytes32 credentialId);
    error InvalidProcessCredential(bytes32 credentialId);
    error InvalidCapacityAllocation(bytes32 allocationId);
    error UnauthorizedParentFactorySigner(bytes32 parentFactoryOrganizationId, address signer);
    error InvalidNonce(uint256 expected, uint256 supplied);
    error InvalidSequence(uint32 expected, uint32 supplied);
    error ExistingParentMismatch(bytes32 childOrderId, bytes32 expectedParentOrderId, bytes32 suppliedParentOrderId);
    error SubcontractCycle(bytes32 childOrderId, bytes32 parentOrderId);
    error MaxDepthExceeded(uint8 maximum, uint8 supplied);
    error InvalidAncestorAuthorization(bytes32 parentOrderId);
    error UnknownSubcontractAuthorization(bytes32 childOrderId);

    event SubcontractPolicyRegistered(
        bytes32 indexed policyHash,
        uint8 maxDepth,
        bytes32 complianceCredentialType,
        bytes32 processCredentialType
    );

    event SubcontractAuthorized(
        bytes32 indexed childOrderId,
        bytes32 indexed parentOrderId,
        bytes32 indexed subcontractorOrganizationId,
        bytes32 buyerOrganizationId,
        bytes32 parentFactoryOrganizationId,
        uint8 depth,
        uint32 sequence,
        bytes32 capacityAllocationId,
        address parentSigner
    );

    constructor(
        address initialAdmin,
        address organizationRegistryAddress,
        address credentialRegistryAddress,
        address orderRegistryAddress,
        address capacityVaultAddress
    ) ThreadProofEIP712("ThreadProof SubcontractGovernor", "1") {
        if (
            initialAdmin == address(0) ||
            organizationRegistryAddress == address(0) ||
            credentialRegistryAddress == address(0) ||
            orderRegistryAddress == address(0) ||
            capacityVaultAddress == address(0)
        ) revert InvalidAddress();

        organizationRegistry = IThreadProofRegistry(organizationRegistryAddress);
        credentialRegistry = ICredentialRegistry(credentialRegistryAddress);
        orderRegistry = IOrderRegistry(orderRegistryAddress);
        capacityVault = ICapacityVault(capacityVaultAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(POLICY_ADMIN_ROLE, initialAdmin);
        _grantRole(PAUSER_ROLE, initialAdmin);
    }

    /// @notice Registers immutable subcontract requirements under an already agreed policy hash.
    /// @dev Production POLICY_ADMIN_ROLE should move to ThreadProofCharter once Charter governance is implemented.
    function registerPolicy(
        bytes32 policyHash,
        uint8 maxDepth,
        bytes32 complianceCredentialType,
        bytes32 processCredentialType
    ) external onlyRole(POLICY_ADMIN_ROLE) {
        if (
            policyHash == bytes32(0) ||
            maxDepth == 0 ||
            maxDepth > HARD_MAX_DEPTH ||
            complianceCredentialType == bytes32(0) ||
            processCredentialType == bytes32(0)
        ) revert InvalidPolicy();
        if (_policies[policyHash].exists) revert PolicyAlreadyRegistered(policyHash);

        _policies[policyHash] = SubcontractPolicy({
            maxDepth: maxDepth,
            complianceCredentialType: complianceCredentialType,
            processCredentialType: processCredentialType,
            exists: true
        });
        emit SubcontractPolicyRegistered(policyHash, maxDepth, complianceCredentialType, processCredentialType);
    }

    /// @notice Finalizes a buyer-consented child order as a subcontract of the current parent order.
    /// @dev Anyone may relay. Authority comes from the buyer-signed OrderRegistry states plus the parent factory EIP-712 signature.
    function authorizeSubcontract(
        SubcontractAuthorization calldata authorization,
        bytes calldata parentFactorySignature
    ) external whenNotPaused {
        if (
            authorization.parentOrderId == bytes32(0) ||
            authorization.childOrderId == bytes32(0) ||
            authorization.parentFactoryOrganizationId == bytes32(0) ||
            authorization.subcontractorOrganizationId == bytes32(0) ||
            authorization.periodId == bytes32(0) ||
            authorization.processId == bytes32(0) ||
            authorization.parentOrderId == authorization.childOrderId
        ) revert InvalidIdentifier();
        if (block.timestamp > authorization.deadline) revert SignatureExpired(authorization.deadline);

        SubcontractPolicy memory policy = _policies[authorization.policyHash];
        if (!policy.exists) revert UnknownPolicy(authorization.policyHash);

        IOrderRegistry.OrderState memory parent = _readOrder(authorization.parentOrderId, true);
        IOrderRegistry.OrderState memory child = _readOrder(authorization.childOrderId, false);
        _validateOrderSnapshots(authorization, parent, child);
        _requireFactory(authorization.parentFactoryOrganizationId);
        _requireFactory(authorization.subcontractorOrganizationId);
        _validateExistingRelation(authorization);

        uint8 depth = _resolveDepth(authorization.parentOrderId, authorization.childOrderId);
        if (depth > policy.maxDepth) revert MaxDepthExceeded(policy.maxDepth, depth);

        bytes32 complianceScope = complianceCredentialScopeHash(
            authorization.subcontractorOrganizationId,
            authorization.policyHash
        );
        if (
            !credentialRegistry.isCredentialValidFor(
                authorization.complianceCredentialId,
                authorization.subcontractorOrganizationId,
                policy.complianceCredentialType,
                complianceScope
            )
        ) revert InvalidComplianceCredential(authorization.complianceCredentialId);

        bytes32 processScope = processCredentialScopeHash(
            authorization.subcontractorOrganizationId,
            authorization.processId,
            authorization.policyHash
        );
        if (
            !credentialRegistry.isCredentialValidFor(
                authorization.processCredentialId,
                authorization.subcontractorOrganizationId,
                policy.processCredentialType,
                processScope
            )
        ) revert InvalidProcessCredential(authorization.processCredentialId);

        if (
            !capacityVault.isCapacityAllocationAuthorized(
                authorization.capacityAllocationId,
                authorization.childOrderId,
                authorization.subcontractorOrganizationId,
                authorization.periodId,
                authorization.processId,
                child.currentOrderCommitment,
                authorization.policyHash
            )
        ) revert InvalidCapacityAllocation(authorization.capacityAllocationId);

        ICapacityVault.CapacityAllocation memory capacityAllocation = capacityVault.getCapacityAllocation(
            authorization.capacityAllocationId
        );

        SubcontractRecord storage existing = _subcontracts[authorization.childOrderId];
        uint32 expectedSequence = existing.exists ? existing.sequence + 1 : 1;
        if (authorization.sequence != expectedSequence) {
            revert InvalidSequence(expectedSequence, authorization.sequence);
        }
        uint256 expectedNonce = nonces[authorization.parentFactoryOrganizationId];
        if (authorization.nonce != expectedNonce) revert InvalidNonce(expectedNonce, authorization.nonce);

        bytes32 structHash = _authorizationStructHash(authorization);
        address signer = _recoverTypedDataSigner(structHash, parentFactorySignature);
        if (organizationRegistry.organizationOfAccount(signer) != authorization.parentFactoryOrganizationId) {
            revert UnauthorizedParentFactorySigner(authorization.parentFactoryOrganizationId, signer);
        }

        _subcontracts[authorization.childOrderId] = SubcontractRecord({
            parentOrderId: authorization.parentOrderId,
            childOrderId: authorization.childOrderId,
            buyerOrganizationId: parent.buyerOrganizationId,
            parentFactoryOrganizationId: authorization.parentFactoryOrganizationId,
            subcontractorOrganizationId: authorization.subcontractorOrganizationId,
            periodId: authorization.periodId,
            processId: authorization.processId,
            policyHash: authorization.policyHash,
            parentVersionHash: authorization.parentVersionHash,
            childVersionHash: authorization.childVersionHash,
            complianceCredentialId: authorization.complianceCredentialId,
            processCredentialId: authorization.processCredentialId,
            capacityAllocationId: authorization.capacityAllocationId,
            capacityStateKey: capacityAllocation.stateKey,
            childOrderCommitment: child.currentOrderCommitment,
            capacityNullifier: capacityAllocation.nullifier,
            sequence: authorization.sequence,
            depth: depth,
            parentSigner: signer,
            authorizedAt: uint64(block.timestamp),
            exists: true
        });
        nonces[authorization.parentFactoryOrganizationId] = expectedNonce + 1;

        emit SubcontractAuthorized(
            authorization.childOrderId,
            authorization.parentOrderId,
            authorization.subcontractorOrganizationId,
            parent.buyerOrganizationId,
            authorization.parentFactoryOrganizationId,
            depth,
            authorization.sequence,
            authorization.capacityAllocationId,
            signer
        );
    }

    function getPolicy(bytes32 policyHash) external view returns (SubcontractPolicy memory) {
        SubcontractPolicy memory policy = _policies[policyHash];
        if (!policy.exists) revert UnknownPolicy(policyHash);
        return policy;
    }

    function getSubcontractAuthorization(bytes32 childOrderId) external view returns (SubcontractRecord memory) {
        SubcontractRecord memory record = _subcontracts[childOrderId];
        if (!record.exists) revert UnknownSubcontractAuthorization(childOrderId);
        return record;
    }

    /// @notice Re-evaluates the full parent chain against current order, organization, credential and capacity state.
    /// @dev Amendments, cancellation, suspension or credential revocation make old authorizations inactive without erasing history.
    function isSubcontractAuthorizationActive(bytes32 childOrderId) public view returns (bool) {
        bytes32 cursor = childOrderId;
        uint8 expectedDepth;

        for (uint8 step = 0; step < HARD_MAX_DEPTH; step++) {
            SubcontractRecord storage record = _subcontracts[cursor];
            if (!record.exists) return false;
            if (expectedDepth != 0 && record.depth != expectedDepth) return false;
            if (!_isRecordLocallyActive(record)) return false;
            if (record.depth == 1) return true;

            expectedDepth = record.depth - 1;
            cursor = record.parentOrderId;
        }
        return false;
    }

    function hashSubcontractAuthorization(
        SubcontractAuthorization calldata authorization
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_authorizationStructHash(authorization));
    }

    function complianceCredentialScopeHash(
        bytes32 subcontractorOrganizationId,
        bytes32 policyHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(COMPLIANCE_SCOPE_DOMAIN, subcontractorOrganizationId, policyHash));
    }

    function processCredentialScopeHash(
        bytes32 subcontractorOrganizationId,
        bytes32 processId,
        bytes32 policyHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(PROCESS_SCOPE_DOMAIN, subcontractorOrganizationId, processId, policyHash));
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _validateOrderSnapshots(
        SubcontractAuthorization calldata authorization,
        IOrderRegistry.OrderState memory parent,
        IOrderRegistry.OrderState memory child
    ) internal view {
        if (parent.status != ORDER_STATUS_ACTIVE) revert InactiveParentOrder(authorization.parentOrderId);
        if (child.status != ORDER_STATUS_ACTIVE) revert InactiveChildOrder(authorization.childOrderId);
        if (parent.buyerOrganizationId != child.buyerOrganizationId) {
            revert BuyerMismatch(parent.buyerOrganizationId, child.buyerOrganizationId);
        }
        if (parent.primaryFactoryOrganizationId != authorization.parentFactoryOrganizationId) {
            revert ParentFactoryMismatch(parent.primaryFactoryOrganizationId, authorization.parentFactoryOrganizationId);
        }
        if (child.primaryFactoryOrganizationId != authorization.subcontractorOrganizationId) {
            revert ChildFactoryMismatch(child.primaryFactoryOrganizationId, authorization.subcontractorOrganizationId);
        }
        if (parent.currentVersionHash != authorization.parentVersionHash) {
            revert ParentVersionMismatch(parent.currentVersionHash, authorization.parentVersionHash);
        }
        if (child.currentVersionHash != authorization.childVersionHash) {
            revert ChildVersionMismatch(child.currentVersionHash, authorization.childVersionHash);
        }
        if (parent.currentPolicyHash != authorization.policyHash) {
            revert PolicyMismatch(parent.currentPolicyHash, authorization.policyHash);
        }
        if (child.currentPolicyHash != authorization.policyHash) {
            revert PolicyMismatch(child.currentPolicyHash, authorization.policyHash);
        }
        if (
            !orderRegistry.isCurrentOrderAuthorization(
                authorization.parentOrderId,
                authorization.parentFactoryOrganizationId,
                parent.currentOrderCommitment,
                authorization.policyHash
            )
        ) revert InvalidParentOrderAuthorization(authorization.parentOrderId);
        if (
            !orderRegistry.isCurrentOrderAuthorization(
                authorization.childOrderId,
                authorization.subcontractorOrganizationId,
                child.currentOrderCommitment,
                authorization.policyHash
            )
        ) revert InvalidChildOrderAuthorization(authorization.childOrderId);
    }

    function _validateExistingRelation(SubcontractAuthorization calldata authorization) internal view {
        SubcontractRecord storage existing = _subcontracts[authorization.childOrderId];
        if (!existing.exists) return;
        if (
            existing.parentOrderId != authorization.parentOrderId ||
            existing.parentFactoryOrganizationId != authorization.parentFactoryOrganizationId ||
            existing.subcontractorOrganizationId != authorization.subcontractorOrganizationId
        ) {
            revert ExistingParentMismatch(
                authorization.childOrderId,
                existing.parentOrderId,
                authorization.parentOrderId
            );
        }
    }

    function _resolveDepth(bytes32 parentOrderId, bytes32 childOrderId) internal view returns (uint8 depth) {
        bytes32 cursor = parentOrderId;
        uint8 traversed;
        while (traversed < HARD_MAX_DEPTH) {
            if (cursor == childOrderId) revert SubcontractCycle(childOrderId, parentOrderId);
            SubcontractRecord storage ancestor = _subcontracts[cursor];
            if (!ancestor.exists) break;
            cursor = ancestor.parentOrderId;
            traversed++;
        }
        if (traversed == HARD_MAX_DEPTH) revert MaxDepthExceeded(HARD_MAX_DEPTH, HARD_MAX_DEPTH + 1);

        SubcontractRecord storage parentAuthorization = _subcontracts[parentOrderId];
        if (!parentAuthorization.exists) return 1;
        if (!isSubcontractAuthorizationActive(parentOrderId)) {
            revert InvalidAncestorAuthorization(parentOrderId);
        }
        depth = parentAuthorization.depth + 1;
    }

    function _isRecordLocallyActive(SubcontractRecord storage record) internal view returns (bool) {
        SubcontractPolicy storage policy = _policies[record.policyHash];
        if (!policy.exists || record.depth == 0 || record.depth > policy.maxDepth) return false;
        if (!_isFactory(record.parentFactoryOrganizationId) || !_isFactory(record.subcontractorOrganizationId)) return false;

        (bool parentFound, IOrderRegistry.OrderState memory parent) = _tryReadOrder(record.parentOrderId);
        (bool childFound, IOrderRegistry.OrderState memory child) = _tryReadOrder(record.childOrderId);
        if (!parentFound || !childFound || parent.status != ORDER_STATUS_ACTIVE || child.status != ORDER_STATUS_ACTIVE) {
            return false;
        }
        if (
            parent.buyerOrganizationId != record.buyerOrganizationId ||
            child.buyerOrganizationId != record.buyerOrganizationId ||
            parent.primaryFactoryOrganizationId != record.parentFactoryOrganizationId ||
            child.primaryFactoryOrganizationId != record.subcontractorOrganizationId ||
            parent.currentVersionHash != record.parentVersionHash ||
            child.currentVersionHash != record.childVersionHash ||
            parent.currentPolicyHash != record.policyHash ||
            child.currentPolicyHash != record.policyHash ||
            child.currentOrderCommitment != record.childOrderCommitment
        ) return false;

        if (
            !orderRegistry.isCurrentOrderAuthorization(
                record.parentOrderId,
                record.parentFactoryOrganizationId,
                parent.currentOrderCommitment,
                record.policyHash
            ) ||
            !orderRegistry.isCurrentOrderAuthorization(
                record.childOrderId,
                record.subcontractorOrganizationId,
                child.currentOrderCommitment,
                record.policyHash
            )
        ) return false;

        if (
            !credentialRegistry.isCredentialValidFor(
                record.complianceCredentialId,
                record.subcontractorOrganizationId,
                policy.complianceCredentialType,
                complianceCredentialScopeHash(record.subcontractorOrganizationId, record.policyHash)
            )
        ) return false;
        if (
            !credentialRegistry.isCredentialValidFor(
                record.processCredentialId,
                record.subcontractorOrganizationId,
                policy.processCredentialType,
                processCredentialScopeHash(record.subcontractorOrganizationId, record.processId, record.policyHash)
            )
        ) return false;

        return capacityVault.isCapacityAllocationAuthorized(
            record.capacityAllocationId,
            record.childOrderId,
            record.subcontractorOrganizationId,
            record.periodId,
            record.processId,
            child.currentOrderCommitment,
            record.policyHash
        );
    }

    function _requireFactory(bytes32 factoryOrganizationId) internal view {
        if (!organizationRegistry.isActive(factoryOrganizationId)) revert InactiveFactory(factoryOrganizationId);
        if (organizationRegistry.roleOf(factoryOrganizationId) != FACTORY_ORGANIZATION_ROLE) {
            revert InvalidFactoryRole(factoryOrganizationId);
        }
    }

    function _isFactory(bytes32 factoryOrganizationId) internal view returns (bool) {
        if (!organizationRegistry.isActive(factoryOrganizationId)) return false;
        try organizationRegistry.roleOf(factoryOrganizationId) returns (uint8 role) {
            return role == FACTORY_ORGANIZATION_ROLE;
        } catch {
            return false;
        }
    }

    function _readOrder(bytes32 orderId, bool parent) internal view returns (IOrderRegistry.OrderState memory state) {
        try orderRegistry.getOrder(orderId) returns (IOrderRegistry.OrderState memory found) {
            return found;
        } catch {
            if (parent) revert UnknownParentOrder(orderId);
            revert UnknownChildOrder(orderId);
        }
    }

    function _tryReadOrder(
        bytes32 orderId
    ) internal view returns (bool found, IOrderRegistry.OrderState memory state) {
        try orderRegistry.getOrder(orderId) returns (IOrderRegistry.OrderState memory current) {
            return (true, current);
        } catch {
            return (false, state);
        }
    }

    function _authorizationStructHash(
        SubcontractAuthorization calldata authorization
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SUBCONTRACT_AUTHORIZATION_TYPEHASH,
                authorization.parentOrderId,
                authorization.childOrderId,
                authorization.parentFactoryOrganizationId,
                authorization.subcontractorOrganizationId,
                authorization.periodId,
                authorization.processId,
                authorization.policyHash,
                authorization.parentVersionHash,
                authorization.childVersionHash,
                authorization.complianceCredentialId,
                authorization.processCredentialId,
                authorization.capacityAllocationId,
                authorization.sequence,
                authorization.nonce,
                authorization.deadline
            )
        );
    }
}
