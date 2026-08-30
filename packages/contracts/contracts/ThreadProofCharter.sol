// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IThreadProofRegistry} from "./interfaces/IThreadProofRegistry.sol";

/// @title ThreadProofCharter
/// @notice Role-diverse consortium governance for exceptional ThreadProof protocol actions.
/// @dev The Charter intentionally has no owner/admin escape hatch. Authority is derived from
///      active organizations in ThreadProofRegistry and snapshotted proposal policies.
contract ThreadProofCharter {
    uint8 public constant BUYER_MASK = 1 << 0;
    uint8 public constant INDUSTRY_MASK = 1 << 1;
    uint8 public constant AUDITOR_MASK = 1 << 2;
    uint8 public constant REGULATOR_MASK = 1 << 3;
    uint8 public constant LABOR_MASK = 1 << 4;
    uint8 public constant ALL_CONSTITUENCIES_MASK = 0x1f;

    bytes32 private constant ORGANIZATION_STATUS_DOMAIN = keccak256("THREADPROOF_CHARTER_ORGANIZATION_STATUS_V1");
    bytes32 private constant PRIMARY_ACCOUNT_ROTATION_DOMAIN = keccak256("THREADPROOF_CHARTER_PRIMARY_ACCOUNT_ROTATION_V1");
    bytes32 private constant PROTECTED_IDENTITY_DISCLOSURE_DOMAIN = keccak256("THREADPROOF_CHARTER_PROTECTED_IDENTITY_DISCLOSURE_V1");
    bytes32 private constant POLICY_UPDATE_DOMAIN = keccak256("THREADPROOF_CHARTER_POLICY_UPDATE_V1");

    enum ProposalType {
        Unknown,
        OrganizationSuspension,
        OrganizationRestore,
        PrimaryAccountRotation,
        ProtectedIdentityDisclosure,
        CharterPolicyUpdate
    }

    enum ProposalState {
        Unknown,
        Pending,
        Timelocked,
        Executable,
        Executed,
        Cancelled,
        Expired
    }

    enum Constituency {
        Unknown,
        Buyer,
        Industry,
        Auditor,
        Regulator,
        Labor
    }

    struct Policy {
        uint8 threshold;
        uint8 eligibleMask;
        uint8 requiredMask;
        uint64 timelockSeconds;
        uint64 votingPeriodSeconds;
        bool exists;
    }

    struct Proposal {
        bytes32 id;
        ProposalType proposalType;
        bytes32 proposerOrganizationId;
        bytes32 actionHash;
        bytes32 metadataHash;
        uint64 policyVersion;
        uint64 createdAt;
        uint64 expiresAt;
        uint64 approvedAt;
        uint64 executeAfter;
        uint8 approvalsReceived;
        uint8 approvalsRequired;
        uint8 eligibleMask;
        uint8 requiredMask;
        uint8 approvalMask;
        uint64 timelockSeconds;
        bool executed;
        bool cancelled;
    }

    IThreadProofRegistry public immutable registry;
    uint64 public policyVersion = 1;
    uint256 public proposalNonce;

    mapping(ProposalType proposalType => Policy policy) public policies;
    mapping(bytes32 proposalId => Proposal proposal) private _proposals;
    mapping(bytes32 proposalId => mapping(bytes32 organizationId => bool approved)) public organizationApproved;

    error InvalidRegistry();
    error InvalidProposalType();
    error InvalidActionHash();
    error InvalidPolicy();
    error UnknownProposal(bytes32 proposalId);
    error InactiveGovernanceRepresentative(address account);
    error IneligibleConstituency(uint8 constituency);
    error ConstituencyAlreadyApproved(uint8 constituency);
    error ProposalNotPending(bytes32 proposalId);
    error ProposalExpired(bytes32 proposalId);
    error ProposalNotExecutable(bytes32 proposalId);
    error ActionHashMismatch(bytes32 expected, bytes32 actual);
    error InvalidExecutionParameters();
    error OnlyProposerOrganization(bytes32 expectedOrganizationId, bytes32 actualOrganizationId);
    error StalePolicyVersion(uint64 expected, uint64 actual);

    event ProposalCreated(
        bytes32 indexed proposalId,
        ProposalType indexed proposalType,
        bytes32 indexed proposerOrganizationId,
        bytes32 actionHash,
        bytes32 metadataHash,
        uint64 policyVersion,
        uint8 approvalsRequired,
        uint64 expiresAt
    );
    event ProposalApprovalRecorded(
        bytes32 indexed proposalId,
        bytes32 indexed organizationId,
        Constituency indexed constituency,
        uint8 approvalsReceived,
        uint8 approvalsRequired,
        uint8 approvalMask
    );
    event ProposalThresholdReached(bytes32 indexed proposalId, uint64 approvedAt, uint64 executeAfter);
    event ProposalCancelled(bytes32 indexed proposalId, bytes32 indexed proposerOrganizationId);
    event ProposalExecuted(bytes32 indexed proposalId, ProposalType indexed proposalType, address indexed executor);
    event CharterPolicyUpdated(
        ProposalType indexed proposalType,
        uint64 indexed newPolicyVersion,
        uint8 threshold,
        uint8 eligibleMask,
        uint8 requiredMask,
        uint64 timelockSeconds,
        uint64 votingPeriodSeconds
    );
    event ProtectedIdentityDisclosureAuthorized(
        bytes32 indexed proposalId,
        bytes32 indexed subjectReference,
        bytes32 indexed evidenceHash
    );

    constructor(address registryAddress) {
        if (registryAddress == address(0)) revert InvalidRegistry();
        registry = IThreadProofRegistry(registryAddress);

        _setPolicy(
            ProposalType.OrganizationSuspension,
            Policy({
                threshold: 2,
                eligibleMask: AUDITOR_MASK | REGULATOR_MASK,
                requiredMask: AUDITOR_MASK | REGULATOR_MASK,
                timelockSeconds: 0,
                votingPeriodSeconds: 2 days,
                exists: true
            })
        );
        _setPolicy(
            ProposalType.OrganizationRestore,
            Policy({
                threshold: 3,
                eligibleMask: ALL_CONSTITUENCIES_MASK,
                requiredMask: AUDITOR_MASK | REGULATOR_MASK,
                timelockSeconds: 6 hours,
                votingPeriodSeconds: 7 days,
                exists: true
            })
        );
        _setPolicy(
            ProposalType.PrimaryAccountRotation,
            Policy({
                threshold: 3,
                eligibleMask: ALL_CONSTITUENCIES_MASK,
                requiredMask: AUDITOR_MASK,
                timelockSeconds: 6 hours,
                votingPeriodSeconds: 7 days,
                exists: true
            })
        );
        _setPolicy(
            ProposalType.ProtectedIdentityDisclosure,
            Policy({
                threshold: 3,
                eligibleMask: ALL_CONSTITUENCIES_MASK,
                requiredMask: AUDITOR_MASK | REGULATOR_MASK,
                timelockSeconds: 1 hours,
                votingPeriodSeconds: 3 days,
                exists: true
            })
        );
        _setPolicy(
            ProposalType.CharterPolicyUpdate,
            Policy({
                threshold: 4,
                eligibleMask: ALL_CONSTITUENCIES_MASK,
                requiredMask: 0,
                timelockSeconds: 1 days,
                votingPeriodSeconds: 7 days,
                exists: true
            })
        );
    }

    function createProposal(
        ProposalType proposalType,
        bytes32 actionHash,
        bytes32 metadataHash
    ) external returns (bytes32 proposalId) {
        if (proposalType == ProposalType.Unknown) revert InvalidProposalType();
        if (actionHash == bytes32(0)) revert InvalidActionHash();

        Policy memory policy = policies[proposalType];
        if (!policy.exists) revert InvalidPolicy();
        (bytes32 proposerOrganizationId,) = _requireRepresentative(msg.sender);

        uint256 nonce = proposalNonce++;
        proposalId = keccak256(
            abi.encode(address(this), block.chainid, nonce, proposalType, proposerOrganizationId, actionHash)
        );
        uint64 createdAt = uint64(block.timestamp);
        uint64 expiresAt = createdAt + policy.votingPeriodSeconds;

        _proposals[proposalId] = Proposal({
            id: proposalId,
            proposalType: proposalType,
            proposerOrganizationId: proposerOrganizationId,
            actionHash: actionHash,
            metadataHash: metadataHash,
            policyVersion: policyVersion,
            createdAt: createdAt,
            expiresAt: expiresAt,
            approvedAt: 0,
            executeAfter: 0,
            approvalsReceived: 0,
            approvalsRequired: policy.threshold,
            eligibleMask: policy.eligibleMask,
            requiredMask: policy.requiredMask,
            approvalMask: 0,
            timelockSeconds: policy.timelockSeconds,
            executed: false,
            cancelled: false
        });

        emit ProposalCreated(
            proposalId,
            proposalType,
            proposerOrganizationId,
            actionHash,
            metadataHash,
            policyVersion,
            policy.threshold,
            expiresAt
        );
    }

    function approveProposal(bytes32 proposalId) external {
        Proposal storage proposal = _requireProposal(proposalId);
        if (proposal.executed || proposal.cancelled || proposal.approvedAt != 0) {
            revert ProposalNotPending(proposalId);
        }
        if (block.timestamp > proposal.expiresAt) revert ProposalExpired(proposalId);

        (bytes32 organizationId, Constituency constituency) = _requireRepresentative(msg.sender);
        uint8 constituencyMask = _maskForConstituency(constituency);
        if ((proposal.eligibleMask & constituencyMask) == 0) {
            revert IneligibleConstituency(uint8(constituency));
        }
        if ((proposal.approvalMask & constituencyMask) != 0) {
            revert ConstituencyAlreadyApproved(uint8(constituency));
        }
        if (organizationApproved[proposalId][organizationId]) {
            revert ConstituencyAlreadyApproved(uint8(constituency));
        }

        organizationApproved[proposalId][organizationId] = true;
        proposal.approvalMask |= constituencyMask;
        proposal.approvalsReceived += 1;

        emit ProposalApprovalRecorded(
            proposalId,
            organizationId,
            constituency,
            proposal.approvalsReceived,
            proposal.approvalsRequired,
            proposal.approvalMask
        );

        bool thresholdReached = proposal.approvalsReceived >= proposal.approvalsRequired;
        bool requiredRolesReached = (proposal.approvalMask & proposal.requiredMask) == proposal.requiredMask;
        if (thresholdReached && requiredRolesReached) {
            proposal.approvedAt = uint64(block.timestamp);
            proposal.executeAfter = proposal.approvedAt + proposal.timelockSeconds;
            emit ProposalThresholdReached(proposalId, proposal.approvedAt, proposal.executeAfter);
        }
    }

    function cancelProposal(bytes32 proposalId) external {
        Proposal storage proposal = _requireProposal(proposalId);
        if (proposal.executed || proposal.cancelled || proposal.approvedAt != 0) {
            revert ProposalNotPending(proposalId);
        }
        (bytes32 organizationId,) = _requireRepresentative(msg.sender);
        if (organizationId != proposal.proposerOrganizationId) {
            revert OnlyProposerOrganization(proposal.proposerOrganizationId, organizationId);
        }
        proposal.cancelled = true;
        emit ProposalCancelled(proposalId, organizationId);
    }

    function executeOrganizationStatus(
        bytes32 proposalId,
        bytes32 organizationId,
        uint8 newStatus
    ) external {
        Proposal storage proposal = _requireExecutable(proposalId);
        if (
            (proposal.proposalType == ProposalType.OrganizationSuspension && newStatus != 2) ||
            (proposal.proposalType == ProposalType.OrganizationRestore && newStatus != 1) ||
            (proposal.proposalType != ProposalType.OrganizationSuspension &&
                proposal.proposalType != ProposalType.OrganizationRestore)
        ) {
            revert InvalidExecutionParameters();
        }
        bytes32 actual = hashOrganizationStatusAction(organizationId, newStatus);
        _consumeAction(proposal, actual);
        registry.setOrganizationStatus(organizationId, newStatus);
        emit ProposalExecuted(proposalId, proposal.proposalType, msg.sender);
    }

    function executePrimaryAccountRotation(
        bytes32 proposalId,
        bytes32 organizationId,
        address newAccount
    ) external {
        if (newAccount == address(0)) revert InvalidExecutionParameters();
        Proposal storage proposal = _requireExecutable(proposalId);
        if (proposal.proposalType != ProposalType.PrimaryAccountRotation) revert InvalidExecutionParameters();
        bytes32 actual = hashPrimaryAccountRotationAction(organizationId, newAccount);
        _consumeAction(proposal, actual);
        registry.rotatePrimaryAccount(organizationId, newAccount);
        emit ProposalExecuted(proposalId, proposal.proposalType, msg.sender);
    }

    function executeProtectedIdentityDisclosure(
        bytes32 proposalId,
        bytes32 subjectReference,
        bytes32 evidenceHash
    ) external {
        if (subjectReference == bytes32(0) || evidenceHash == bytes32(0)) revert InvalidExecutionParameters();
        Proposal storage proposal = _requireExecutable(proposalId);
        if (proposal.proposalType != ProposalType.ProtectedIdentityDisclosure) revert InvalidExecutionParameters();
        bytes32 actual = hashProtectedIdentityDisclosureAction(subjectReference, evidenceHash);
        _consumeAction(proposal, actual);
        emit ProtectedIdentityDisclosureAuthorized(proposalId, subjectReference, evidenceHash);
        emit ProposalExecuted(proposalId, proposal.proposalType, msg.sender);
    }

    function executePolicyUpdate(
        bytes32 proposalId,
        ProposalType targetProposalType,
        Policy calldata newPolicy
    ) external {
        Proposal storage proposal = _requireExecutable(proposalId);
        if (proposal.proposalType != ProposalType.CharterPolicyUpdate || targetProposalType == ProposalType.Unknown) {
            revert InvalidExecutionParameters();
        }
        if (policyVersion != proposal.policyVersion) {
            revert StalePolicyVersion(proposal.policyVersion, policyVersion);
        }
        _validatePolicy(newPolicy);
        bytes32 actual = hashPolicyUpdateAction(
            targetProposalType,
            newPolicy.threshold,
            newPolicy.eligibleMask,
            newPolicy.requiredMask,
            newPolicy.timelockSeconds,
            newPolicy.votingPeriodSeconds,
            proposal.policyVersion
        );
        _consumeAction(proposal, actual);

        Policy memory normalized = newPolicy;
        normalized.exists = true;
        _setPolicy(targetProposalType, normalized);
        policyVersion += 1;

        emit CharterPolicyUpdated(
            targetProposalType,
            policyVersion,
            normalized.threshold,
            normalized.eligibleMask,
            normalized.requiredMask,
            normalized.timelockSeconds,
            normalized.votingPeriodSeconds
        );
        emit ProposalExecuted(proposalId, proposal.proposalType, msg.sender);
    }

    function getProposal(bytes32 proposalId) external view returns (Proposal memory) {
        return _requireProposal(proposalId);
    }

    function getProposalState(bytes32 proposalId) public view returns (ProposalState) {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.id == bytes32(0)) return ProposalState.Unknown;
        if (proposal.executed) return ProposalState.Executed;
        if (proposal.cancelled) return ProposalState.Cancelled;
        if (proposal.approvedAt != 0) {
            if (block.timestamp < proposal.executeAfter) return ProposalState.Timelocked;
            return ProposalState.Executable;
        }
        if (block.timestamp > proposal.expiresAt) return ProposalState.Expired;
        return ProposalState.Pending;
    }

    function constituencyForOrganization(bytes32 organizationId) external view returns (Constituency) {
        return _constituencyForRole(registry.roleOf(organizationId));
    }

    function hashOrganizationStatusAction(bytes32 organizationId, uint8 newStatus) public pure returns (bytes32) {
        return keccak256(abi.encode(ORGANIZATION_STATUS_DOMAIN, organizationId, newStatus));
    }

    function hashPrimaryAccountRotationAction(bytes32 organizationId, address newAccount) public pure returns (bytes32) {
        return keccak256(abi.encode(PRIMARY_ACCOUNT_ROTATION_DOMAIN, organizationId, newAccount));
    }

    function hashProtectedIdentityDisclosureAction(
        bytes32 subjectReference,
        bytes32 evidenceHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(PROTECTED_IDENTITY_DISCLOSURE_DOMAIN, subjectReference, evidenceHash));
    }

    function hashPolicyUpdateAction(
        ProposalType targetProposalType,
        uint8 threshold,
        uint8 eligibleMask,
        uint8 requiredMask,
        uint64 timelockSeconds,
        uint64 votingPeriodSeconds,
        uint64 expectedPolicyVersion
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POLICY_UPDATE_DOMAIN,
                targetProposalType,
                threshold,
                eligibleMask,
                requiredMask,
                timelockSeconds,
                votingPeriodSeconds,
                expectedPolicyVersion
            )
        );
    }

    function _requireRepresentative(address account) internal view returns (bytes32 organizationId, Constituency constituency) {
        organizationId = registry.organizationOfAccount(account);
        if (organizationId == bytes32(0) || !registry.isActive(organizationId)) {
            revert InactiveGovernanceRepresentative(account);
        }
        constituency = _constituencyForRole(registry.roleOf(organizationId));
        if (constituency == Constituency.Unknown) revert IneligibleConstituency(0);
    }

    function _constituencyForRole(uint8 organizationRole) internal pure returns (Constituency) {
        if (organizationRole == 1) return Constituency.Buyer;
        if (organizationRole == 2 || organizationRole == 5) return Constituency.Industry;
        if (organizationRole == 3 || organizationRole == 7) return Constituency.Auditor;
        if (organizationRole == 4) return Constituency.Regulator;
        if (organizationRole == 6) return Constituency.Labor;
        return Constituency.Unknown;
    }

    function _maskForConstituency(Constituency constituency) internal pure returns (uint8) {
        if (constituency == Constituency.Unknown) return 0;
        return uint8(1) << (uint8(constituency) - 1);
    }

    function _requireProposal(bytes32 proposalId) internal view returns (Proposal storage proposal) {
        proposal = _proposals[proposalId];
        if (proposal.id == bytes32(0)) revert UnknownProposal(proposalId);
    }

    function _requireExecutable(bytes32 proposalId) internal view returns (Proposal storage proposal) {
        proposal = _requireProposal(proposalId);
        if (
            proposal.executed ||
            proposal.cancelled ||
            proposal.approvedAt == 0 ||
            block.timestamp < proposal.executeAfter
        ) {
            revert ProposalNotExecutable(proposalId);
        }
    }

    function _consumeAction(Proposal storage proposal, bytes32 actualActionHash) internal {
        if (proposal.actionHash != actualActionHash) {
            revert ActionHashMismatch(proposal.actionHash, actualActionHash);
        }
        proposal.executed = true;
    }

    function _setPolicy(ProposalType proposalType, Policy memory policy) internal {
        _validatePolicy(policy);
        policy.exists = true;
        policies[proposalType] = policy;
    }

    function _validatePolicy(Policy memory policy) internal pure {
        if (
            policy.threshold == 0 ||
            policy.threshold > 5 ||
            policy.eligibleMask == 0 ||
            (policy.eligibleMask & ~ALL_CONSTITUENCIES_MASK) != 0 ||
            (policy.requiredMask & ~policy.eligibleMask) != 0 ||
            _countBits(policy.eligibleMask) < policy.threshold ||
            _countBits(policy.requiredMask) > policy.threshold ||
            policy.votingPeriodSeconds == 0
        ) {
            revert InvalidPolicy();
        }
    }

    function _countBits(uint8 value) internal pure returns (uint8 count) {
        for (uint8 bit = 0; bit < 5; bit += 1) {
            if ((value & (uint8(1) << bit)) != 0) count += 1;
        }
    }
}
