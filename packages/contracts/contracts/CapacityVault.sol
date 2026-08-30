// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ICapacitySpendVerifier} from "./interfaces/ICapacitySpendVerifier.sol";
import {ICredentialRegistry} from "./interfaces/ICredentialRegistry.sol";
import {IOrderRegistry} from "./interfaces/IOrderRegistry.sol";
import {IThreadProofRegistry} from "./interfaces/IThreadProofRegistry.sol";

/// @title CapacityVault
/// @notice Canonical on-chain state machine for confidential certified production capacity.
/// @dev Exact capacity never enters contract storage. Only commitments, allocation references and nullifiers are shared.
contract CapacityVault is AccessControl, Pausable {
    bytes32 public constant CERTIFIER_ROLE = keccak256("CERTIFIER_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant VERIFIER_ADMIN_ROLE = keccak256("VERIFIER_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant CAPACITY_CREDENTIAL_TYPE = keccak256("CAPACITY_CREDENTIAL");

    // BN254 scalar field used by Groth16/Circom public signals.
    uint256 public constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct CapacityState {
        uint256 activeCommitment;
        bytes32 capacityCredentialId;
        bytes32 policyHash;
        uint32 circuitVersion;
        uint64 updatedAt;
        bool active;
    }

    struct SpendRequest {
        bytes32 factoryOrganizationId;
        bytes32 periodId;
        bytes32 processId;
        bytes32 orderId;
        bytes32 policyHash;
        uint256 oldCapacityCommitment;
        uint256 newCapacityCommitment;
        uint256 orderCommitment;
        uint256 nullifier;
        uint32 circuitVersion;
    }

    /// @notice Immutable receipt that a specific order consumed one canonical capacity state.
    /// @dev It stores commitments/IDs only; exact workload and remaining capacity remain private.
    struct CapacityAllocation {
        bytes32 stateKey;
        bytes32 orderId;
        bytes32 factoryOrganizationId;
        bytes32 periodId;
        bytes32 processId;
        bytes32 capacityCredentialId;
        uint256 orderCommitment;
        bytes32 policyHash;
        uint256 nullifier;
        uint32 circuitVersion;
        uint64 authorizedAt;
        bool exists;
    }

    ICredentialRegistry public immutable credentialRegistry;
    IOrderRegistry public immutable orderRegistry;
    IThreadProofRegistry public immutable organizationRegistry;

    mapping(bytes32 stateKey => CapacityState state) private _capacityStates;
    mapping(bytes32 allocationId => CapacityAllocation allocation) private _capacityAllocations;
    mapping(uint256 nullifier => bool used) public usedNullifiers;
    mapping(uint32 circuitVersion => ICapacitySpendVerifier verifier) public verifiers;

    error InvalidAddress();
    error InvalidCommitment();
    error InvalidFieldElement();
    error CapacityStateAlreadyExists(bytes32 stateKey);
    error UnknownCapacityState(bytes32 stateKey);
    error UnknownCapacityAllocation(bytes32 allocationId);
    error StaleCapacityState(uint256 expected, uint256 supplied);
    error NullifierAlreadyUsed(uint256 nullifier);
    error InvalidCredential(bytes32 credentialId);
    error InvalidCredentialBinding(bytes32 credentialId, bytes32 expectedScopeHash);
    error InvalidOrderAuthorization(bytes32 orderId);
    error PolicyMismatch(bytes32 expected, bytes32 supplied);
    error CircuitVersionMismatch(uint32 expected, uint32 supplied);
    error UnknownVerifier(uint32 circuitVersion);
    error InvalidProof();
    error UnauthorizedFactoryCaller(bytes32 factoryOrganizationId, address caller);
    error InactiveFactory(bytes32 factoryOrganizationId);

    event CapacityCertified(
        bytes32 indexed stateKey,
        bytes32 indexed factoryOrganizationId,
        bytes32 indexed capacityCredentialId,
        bytes32 periodId,
        bytes32 processId,
        uint256 commitment,
        bytes32 policyHash,
        uint32 circuitVersion
    );

    event CapacitySpent(
        bytes32 indexed stateKey,
        bytes32 indexed orderId,
        uint256 indexed nullifier,
        uint256 oldCommitment,
        uint256 newCommitment,
        uint256 orderCommitment,
        uint32 circuitVersion
    );

    event CapacityAllocationRecorded(
        bytes32 indexed allocationId,
        bytes32 indexed orderId,
        bytes32 indexed factoryOrganizationId,
        bytes32 stateKey,
        uint256 nullifier
    );

    event VerifierRegistered(uint32 indexed circuitVersion, address indexed verifier);

    constructor(
        address initialAdmin,
        address credentialRegistryAddress,
        address orderRegistryAddress,
        address organizationRegistryAddress
    ) {
        if (
            initialAdmin == address(0) ||
            credentialRegistryAddress == address(0) ||
            orderRegistryAddress == address(0) ||
            organizationRegistryAddress == address(0)
        ) revert InvalidAddress();

        credentialRegistry = ICredentialRegistry(credentialRegistryAddress);
        orderRegistry = IOrderRegistry(orderRegistryAddress);
        organizationRegistry = IThreadProofRegistry(organizationRegistryAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(CERTIFIER_ROLE, initialAdmin);
        _grantRole(VERIFIER_ADMIN_ROLE, initialAdmin);
        _grantRole(PAUSER_ROLE, initialAdmin);
    }

    function registerVerifier(uint32 circuitVersion, address verifierAddress) external onlyRole(VERIFIER_ADMIN_ROLE) {
        if (verifierAddress == address(0) || verifierAddress.code.length == 0) revert InvalidAddress();
        verifiers[circuitVersion] = ICapacitySpendVerifier(verifierAddress);
        emit VerifierRegistered(circuitVersion, verifierAddress);
    }

    function certifyCapacity(
        bytes32 factoryOrganizationId,
        bytes32 periodId,
        bytes32 processId,
        uint256 initialCommitment,
        bytes32 capacityCredentialId,
        bytes32 policyHash,
        uint32 circuitVersion
    ) external onlyRole(CERTIFIER_ROLE) whenNotPaused {
        _requireFieldElement(initialCommitment);
        if (initialCommitment == 0) revert InvalidCommitment();
        if (!organizationRegistry.isActive(factoryOrganizationId)) revert InactiveFactory(factoryOrganizationId);

        bytes32 expectedScopeHash = capacityCredentialScopeHash(
            factoryOrganizationId,
            periodId,
            processId,
            policyHash,
            initialCommitment
        );
        if (
            !credentialRegistry.isCredentialValidFor(
                capacityCredentialId,
                factoryOrganizationId,
                CAPACITY_CREDENTIAL_TYPE,
                expectedScopeHash
            )
        ) {
            revert InvalidCredentialBinding(capacityCredentialId, expectedScopeHash);
        }
        if (address(verifiers[circuitVersion]) == address(0)) revert UnknownVerifier(circuitVersion);

        bytes32 key = capacityStateKey(factoryOrganizationId, periodId, processId);
        if (_capacityStates[key].active) revert CapacityStateAlreadyExists(key);

        _capacityStates[key] = CapacityState({
            activeCommitment: initialCommitment,
            capacityCredentialId: capacityCredentialId,
            policyHash: policyHash,
            circuitVersion: circuitVersion,
            updatedAt: uint64(block.timestamp),
            active: true
        });

        emit CapacityCertified(
            key,
            factoryOrganizationId,
            capacityCredentialId,
            periodId,
            processId,
            initialCommitment,
            policyHash,
            circuitVersion
        );
    }

    /// @notice Atomically verifies and consumes the current confidential capacity state.
    /// @dev A proof can be mathematically valid yet still fail here if another transaction already consumed the state.
    function spendCapacity(
        SpendRequest calldata request,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external whenNotPaused {
        bytes32 callerOrganizationId = organizationRegistry.organizationOfAccount(msg.sender);
        if (callerOrganizationId != request.factoryOrganizationId && !hasRole(RELAYER_ROLE, msg.sender)) {
            revert UnauthorizedFactoryCaller(request.factoryOrganizationId, msg.sender);
        }
        if (!organizationRegistry.isActive(request.factoryOrganizationId)) {
            revert InactiveFactory(request.factoryOrganizationId);
        }

        bytes32 key = capacityStateKey(request.factoryOrganizationId, request.periodId, request.processId);
        CapacityState storage state = _capacityStates[key];
        if (!state.active) revert UnknownCapacityState(key);
        if (state.activeCommitment != request.oldCapacityCommitment) {
            revert StaleCapacityState(state.activeCommitment, request.oldCapacityCommitment);
        }
        if (usedNullifiers[request.nullifier]) revert NullifierAlreadyUsed(request.nullifier);
        if (state.policyHash != request.policyHash) revert PolicyMismatch(state.policyHash, request.policyHash);
        if (state.circuitVersion != request.circuitVersion) {
            revert CircuitVersionMismatch(state.circuitVersion, request.circuitVersion);
        }
        if (!credentialRegistry.isCredentialActive(state.capacityCredentialId)) {
            revert InvalidCredential(state.capacityCredentialId);
        }
        if (
            !orderRegistry.isCurrentOrderAuthorization(
                request.orderId,
                request.factoryOrganizationId,
                request.orderCommitment,
                request.policyHash
            )
        ) {
            revert InvalidOrderAuthorization(request.orderId);
        }

        _requireFieldElement(request.oldCapacityCommitment);
        _requireFieldElement(request.newCapacityCommitment);
        _requireFieldElement(request.orderCommitment);
        _requireFieldElement(request.nullifier);
        if (request.newCapacityCommitment == 0) revert InvalidCommitment();

        ICapacitySpendVerifier verifier = verifiers[request.circuitVersion];
        if (address(verifier) == address(0)) revert UnknownVerifier(request.circuitVersion);

        uint256[9] memory signals = [
            _toField(request.factoryOrganizationId),
            _toField(request.periodId),
            _toField(request.processId),
            _toField(request.orderId),
            _toField(request.policyHash),
            request.oldCapacityCommitment,
            request.newCapacityCommitment,
            request.orderCommitment,
            request.nullifier
        ];

        if (!verifier.verifyProof(a, b, c, signals)) revert InvalidProof();

        // Canonical compare-and-swap: this update and nullifier consumption happen in the same transaction.
        usedNullifiers[request.nullifier] = true;
        uint256 previousCommitment = state.activeCommitment;
        bytes32 capacityCredentialId = state.capacityCredentialId;
        state.activeCommitment = request.newCapacityCommitment;
        state.updatedAt = uint64(block.timestamp);

        bytes32 allocationId = capacityAllocationId(key, request.orderId, request.nullifier);
        _capacityAllocations[allocationId] = CapacityAllocation({
            stateKey: key,
            orderId: request.orderId,
            factoryOrganizationId: request.factoryOrganizationId,
            periodId: request.periodId,
            processId: request.processId,
            capacityCredentialId: capacityCredentialId,
            orderCommitment: request.orderCommitment,
            policyHash: request.policyHash,
            nullifier: request.nullifier,
            circuitVersion: request.circuitVersion,
            authorizedAt: uint64(block.timestamp),
            exists: true
        });

        emit CapacitySpent(
            key,
            request.orderId,
            request.nullifier,
            previousCommitment,
            request.newCapacityCommitment,
            request.orderCommitment,
            request.circuitVersion
        );
        emit CapacityAllocationRecorded(
            allocationId,
            request.orderId,
            request.factoryOrganizationId,
            key,
            request.nullifier
        );
    }

    function getCapacityState(
        bytes32 factoryOrganizationId,
        bytes32 periodId,
        bytes32 processId
    ) external view returns (CapacityState memory) {
        bytes32 key = capacityStateKey(factoryOrganizationId, periodId, processId);
        CapacityState memory state = _capacityStates[key];
        if (!state.active) revert UnknownCapacityState(key);
        return state;
    }

    function getCapacityAllocation(bytes32 allocationId) external view returns (CapacityAllocation memory) {
        CapacityAllocation memory allocation = _capacityAllocations[allocationId];
        if (!allocation.exists) revert UnknownCapacityAllocation(allocationId);
        return allocation;
    }

    /// @notice Returns whether a historical PoFC allocation still authorizes the exact current order context.
    /// @dev Historical records remain immutable; amendments, cancellation, revocation or suspension fail closed for new use.
    function isCapacityAllocationAuthorized(
        bytes32 allocationId,
        bytes32 orderId,
        bytes32 factoryOrganizationId,
        bytes32 periodId,
        bytes32 processId,
        uint256 orderCommitment,
        bytes32 policyHash
    ) external view returns (bool) {
        CapacityAllocation storage allocation = _capacityAllocations[allocationId];
        if (!allocation.exists) return false;
        if (
            allocation.orderId != orderId ||
            allocation.factoryOrganizationId != factoryOrganizationId ||
            allocation.periodId != periodId ||
            allocation.processId != processId ||
            allocation.orderCommitment != orderCommitment ||
            allocation.policyHash != policyHash ||
            allocation.stateKey != capacityStateKey(factoryOrganizationId, periodId, processId)
        ) return false;
        if (!usedNullifiers[allocation.nullifier]) return false;
        if (!organizationRegistry.isActive(factoryOrganizationId)) return false;
        if (!credentialRegistry.isCredentialActive(allocation.capacityCredentialId)) return false;
        return orderRegistry.isCurrentOrderAuthorization(orderId, factoryOrganizationId, orderCommitment, policyHash);
    }

    function capacityStateKey(
        bytes32 factoryOrganizationId,
        bytes32 periodId,
        bytes32 processId
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(factoryOrganizationId, periodId, processId));
    }

    function capacityAllocationId(
        bytes32 stateKey,
        bytes32 orderId,
        uint256 nullifier
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(stateKey, orderId, nullifier));
    }

    /// @notice Deterministic capacity-credential scope enforced at initial certification.
    /// @dev Binding includes the initial commitment so one credential cannot certify a different opening.
    function capacityCredentialScopeHash(
        bytes32 factoryOrganizationId,
        bytes32 periodId,
        bytes32 processId,
        bytes32 policyHash,
        uint256 initialCommitment
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(factoryOrganizationId, periodId, processId, policyHash, initialCommitment));
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _toField(bytes32 value) internal pure returns (uint256) {
        return uint256(value) % SNARK_SCALAR_FIELD;
    }

    function _requireFieldElement(uint256 value) internal pure {
        if (value >= SNARK_SCALAR_FIELD) revert InvalidFieldElement();
    }
}
