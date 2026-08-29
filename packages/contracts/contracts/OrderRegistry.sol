// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IThreadProofRegistry} from "./interfaces/IThreadProofRegistry.sol";

/// @title OrderRegistry
/// @notice Canonical buyer-authorized order versions for ThreadProof capacity and subcontract workflows.
/// @dev Commercial payloads remain private. The chain stores only commitments, policy context and signed version history.
contract OrderRegistry is EIP712 {
    uint8 public constant BUYER_ORGANIZATION_ROLE = 1;
    uint8 public constant FACTORY_ORGANIZATION_ROLE = 2;

    bytes32 public constant ORDER_VERSION_TYPEHASH = keccak256(
        "OrderVersion(bytes32 orderId,bytes32 buyerOrganizationId,bytes32 primaryFactoryOrganizationId,uint32 version,bytes32 previousVersionHash,uint256 orderCommitment,bytes32 policyHash,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant CANCEL_ORDER_TYPEHASH = keccak256(
        "CancelOrder(bytes32 orderId,bytes32 buyerOrganizationId,uint32 expectedVersion,uint256 nonce,uint64 deadline)"
    );

    enum OrderStatus {
        Unknown,
        Active,
        Cancelled
    }

    struct OrderVersionAuthorization {
        bytes32 orderId;
        bytes32 buyerOrganizationId;
        bytes32 primaryFactoryOrganizationId;
        uint32 version;
        bytes32 previousVersionHash;
        uint256 orderCommitment;
        bytes32 policyHash;
        uint256 nonce;
        uint64 deadline;
    }

    struct CancelAuthorization {
        bytes32 orderId;
        bytes32 buyerOrganizationId;
        uint32 expectedVersion;
        uint256 nonce;
        uint64 deadline;
    }

    struct OrderState {
        bytes32 buyerOrganizationId;
        bytes32 primaryFactoryOrganizationId;
        uint32 currentVersion;
        bytes32 currentVersionHash;
        uint256 currentOrderCommitment;
        bytes32 currentPolicyHash;
        uint64 updatedAt;
        OrderStatus status;
    }

    struct OrderVersionRecord {
        bytes32 primaryFactoryOrganizationId;
        uint32 version;
        bytes32 previousVersionHash;
        bytes32 versionHash;
        uint256 orderCommitment;
        bytes32 policyHash;
        uint256 nonce;
        address buyerSigner;
        uint64 recordedAt;
    }

    IThreadProofRegistry public immutable organizationRegistry;

    mapping(bytes32 orderId => OrderState state) private _orders;
    mapping(bytes32 orderId => mapping(uint32 version => OrderVersionRecord record)) private _orderVersions;
    mapping(bytes32 buyerOrganizationId => uint256 nextNonce) public nonces;

    error InvalidAddress();
    error InvalidOrderId();
    error InvalidCommitment();
    error SignatureExpired(uint64 deadline);
    error InactiveBuyer(bytes32 buyerOrganizationId);
    error InvalidBuyerRole(bytes32 buyerOrganizationId);
    error InactiveFactory(bytes32 factoryOrganizationId);
    error InvalidFactoryRole(bytes32 factoryOrganizationId);
    error InvalidNonce(uint256 expected, uint256 supplied);
    error InvalidVersion(uint32 expected, uint32 supplied);
    error PreviousVersionHashMismatch(bytes32 expected, bytes32 supplied);
    error UnauthorizedBuyerSigner(bytes32 buyerOrganizationId, address signer);
    error UnknownOrder(bytes32 orderId);
    error OrderNotActive(bytes32 orderId);
    error BuyerMismatch(bytes32 expected, bytes32 supplied);

    event OrderVersionRecorded(
        bytes32 indexed orderId,
        bytes32 indexed buyerOrganizationId,
        bytes32 indexed primaryFactoryOrganizationId,
        uint32 version,
        bytes32 versionHash,
        uint256 orderCommitment,
        bytes32 policyHash,
        uint256 nonce,
        address buyerSigner
    );

    event OrderCancelled(
        bytes32 indexed orderId,
        bytes32 indexed buyerOrganizationId,
        uint32 indexed version,
        uint256 nonce,
        address buyerSigner
    );

    constructor(address organizationRegistryAddress) EIP712("ThreadProof OrderRegistry", "1") {
        if (organizationRegistryAddress == address(0)) revert InvalidAddress();
        organizationRegistry = IThreadProofRegistry(organizationRegistryAddress);
    }

    /// @notice Creates version 1 or appends exactly the next buyer-signed immutable order version.
    /// @dev Anyone may relay the signed message; authorization comes from the recovered buyer organization signer.
    function submitOrderVersion(
        OrderVersionAuthorization calldata authorization,
        bytes calldata buyerSignature
    ) external returns (bytes32 versionHash) {
        _validateOrganizations(
            authorization.buyerOrganizationId,
            authorization.primaryFactoryOrganizationId
        );
        if (authorization.orderId == bytes32(0)) revert InvalidOrderId();
        if (authorization.orderCommitment == 0) revert InvalidCommitment();
        if (block.timestamp > authorization.deadline) revert SignatureExpired(authorization.deadline);

        uint256 expectedNonce = nonces[authorization.buyerOrganizationId];
        if (authorization.nonce != expectedNonce) {
            revert InvalidNonce(expectedNonce, authorization.nonce);
        }

        bytes32 digest = _hashTypedDataV4(_orderVersionStructHash(authorization));
        address signer = ECDSA.recover(digest, buyerSignature);
        if (organizationRegistry.organizationOfAccount(signer) != authorization.buyerOrganizationId) {
            revert UnauthorizedBuyerSigner(authorization.buyerOrganizationId, signer);
        }

        OrderState storage state = _orders[authorization.orderId];
        if (state.status == OrderStatus.Unknown) {
            if (authorization.version != 1) revert InvalidVersion(1, authorization.version);
            if (authorization.previousVersionHash != bytes32(0)) {
                revert PreviousVersionHashMismatch(bytes32(0), authorization.previousVersionHash);
            }
            state.buyerOrganizationId = authorization.buyerOrganizationId;
        } else {
            if (state.status != OrderStatus.Active) revert OrderNotActive(authorization.orderId);
            if (state.buyerOrganizationId != authorization.buyerOrganizationId) {
                revert BuyerMismatch(state.buyerOrganizationId, authorization.buyerOrganizationId);
            }

            uint32 expectedVersion = state.currentVersion + 1;
            if (authorization.version != expectedVersion) {
                revert InvalidVersion(expectedVersion, authorization.version);
            }
            if (authorization.previousVersionHash != state.currentVersionHash) {
                revert PreviousVersionHashMismatch(state.currentVersionHash, authorization.previousVersionHash);
            }
        }

        uint64 recordedAt = uint64(block.timestamp);
        versionHash = keccak256(abi.encode(digest, recordedAt));
        _orderVersions[authorization.orderId][authorization.version] = OrderVersionRecord({
            primaryFactoryOrganizationId: authorization.primaryFactoryOrganizationId,
            version: authorization.version,
            previousVersionHash: authorization.previousVersionHash,
            versionHash: versionHash,
            orderCommitment: authorization.orderCommitment,
            policyHash: authorization.policyHash,
            nonce: authorization.nonce,
            buyerSigner: signer,
            recordedAt: recordedAt
        });

        state.primaryFactoryOrganizationId = authorization.primaryFactoryOrganizationId;
        state.currentVersion = authorization.version;
        state.currentVersionHash = versionHash;
        state.currentOrderCommitment = authorization.orderCommitment;
        state.currentPolicyHash = authorization.policyHash;
        state.updatedAt = recordedAt;
        state.status = OrderStatus.Active;

        nonces[authorization.buyerOrganizationId] = expectedNonce + 1;

        emit OrderVersionRecorded(
            authorization.orderId,
            authorization.buyerOrganizationId,
            authorization.primaryFactoryOrganizationId,
            authorization.version,
            versionHash,
            authorization.orderCommitment,
            authorization.policyHash,
            authorization.nonce,
            signer
        );
    }

    /// @notice Cancels the current order under a buyer-signed nonce/version-bound authorization.
    function cancelOrder(CancelAuthorization calldata authorization, bytes calldata buyerSignature) external {
        if (authorization.orderId == bytes32(0)) revert InvalidOrderId();
        if (block.timestamp > authorization.deadline) revert SignatureExpired(authorization.deadline);

        OrderState storage state = _orders[authorization.orderId];
        if (state.status == OrderStatus.Unknown) revert UnknownOrder(authorization.orderId);
        if (state.status != OrderStatus.Active) revert OrderNotActive(authorization.orderId);
        if (state.buyerOrganizationId != authorization.buyerOrganizationId) {
            revert BuyerMismatch(state.buyerOrganizationId, authorization.buyerOrganizationId);
        }
        _validateBuyer(authorization.buyerOrganizationId);

        if (authorization.expectedVersion != state.currentVersion) {
            revert InvalidVersion(state.currentVersion, authorization.expectedVersion);
        }

        uint256 expectedNonce = nonces[authorization.buyerOrganizationId];
        if (authorization.nonce != expectedNonce) {
            revert InvalidNonce(expectedNonce, authorization.nonce);
        }

        bytes32 structHash = keccak256(
            abi.encode(
                CANCEL_ORDER_TYPEHASH,
                authorization.orderId,
                authorization.buyerOrganizationId,
                authorization.expectedVersion,
                authorization.nonce,
                authorization.deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), buyerSignature);
        if (organizationRegistry.organizationOfAccount(signer) != authorization.buyerOrganizationId) {
            revert UnauthorizedBuyerSigner(authorization.buyerOrganizationId, signer);
        }

        state.status = OrderStatus.Cancelled;
        state.updatedAt = uint64(block.timestamp);
        nonces[authorization.buyerOrganizationId] = expectedNonce + 1;

        emit OrderCancelled(
            authorization.orderId,
            authorization.buyerOrganizationId,
            authorization.expectedVersion,
            authorization.nonce,
            signer
        );
    }

    function getOrder(bytes32 orderId) external view returns (OrderState memory) {
        OrderState memory state = _orders[orderId];
        if (state.status == OrderStatus.Unknown) revert UnknownOrder(orderId);
        return state;
    }

    function getOrderVersion(bytes32 orderId, uint32 version) external view returns (OrderVersionRecord memory) {
        OrderVersionRecord memory record = _orderVersions[orderId][version];
        if (record.version == 0) revert InvalidVersion(1, version);
        return record;
    }

    /// @notice CapacityVault/SubcontractGovernor hook for current buyer-authorized order context.
    function isCurrentOrderAuthorization(
        bytes32 orderId,
        bytes32 factoryOrganizationId,
        uint256 orderCommitment,
        bytes32 policyHash
    ) external view returns (bool) {
        OrderState storage state = _orders[orderId];
        if (state.status != OrderStatus.Active) return false;
        if (!organizationRegistry.isActive(state.buyerOrganizationId)) return false;
        if (!organizationRegistry.isActive(factoryOrganizationId)) return false;
        return
            state.primaryFactoryOrganizationId == factoryOrganizationId &&
            state.currentOrderCommitment == orderCommitment &&
            state.currentPolicyHash == policyHash;
    }

    function hashOrderVersionAuthorization(
        OrderVersionAuthorization calldata authorization
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_orderVersionStructHash(authorization));
    }

    function _orderVersionStructHash(
        OrderVersionAuthorization calldata authorization
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_VERSION_TYPEHASH,
                authorization.orderId,
                authorization.buyerOrganizationId,
                authorization.primaryFactoryOrganizationId,
                authorization.version,
                authorization.previousVersionHash,
                authorization.orderCommitment,
                authorization.policyHash,
                authorization.nonce,
                authorization.deadline
            )
        );
    }

    function _validateOrganizations(bytes32 buyerOrganizationId, bytes32 factoryOrganizationId) internal view {
        _validateBuyer(buyerOrganizationId);
        if (!organizationRegistry.isActive(factoryOrganizationId)) revert InactiveFactory(factoryOrganizationId);
        if (organizationRegistry.roleOf(factoryOrganizationId) != FACTORY_ORGANIZATION_ROLE) {
            revert InvalidFactoryRole(factoryOrganizationId);
        }
    }

    function _validateBuyer(bytes32 buyerOrganizationId) internal view {
        if (!organizationRegistry.isActive(buyerOrganizationId)) revert InactiveBuyer(buyerOrganizationId);
        if (organizationRegistry.roleOf(buyerOrganizationId) != BUYER_ORGANIZATION_ROLE) {
            revert InvalidBuyerRole(buyerOrganizationId);
        }
    }
}
