pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

/// CapacityRelease proves restoration of one previously allocated confidential workload.
///
/// Invariants enforced by the circuit:
/// 1. the prover opens the currently canonical capacity commitment;
/// 2. the hidden released workload opens the historical order commitment;
/// 3. restoredCapacity = currentCapacity + orderWorkload;
/// 4. current/restored/workload values are unsigned 64-bit integers, preventing overflow;
/// 5. the next capacity commitment is derived for the same factory/period/process/policy;
/// 6. a release-domain nullifier is bound to the current commitment and order commitment.
///
/// Eligibility of the historical allocation for release is intentionally enforced by
/// CapacityVault against canonical order/allocation state; exact capacities and workload
/// remain private witness values here.
template CapacityRelease() {
    // Public business/domain identifiers.
    signal input factoryId;
    signal input periodId;
    signal input processId;
    signal input orderId;
    signal input policyHash;

    // Public cryptographic state. These occupy the same nine-signal shape as CapacitySpend,
    // but are verified through a separate release-verifier namespace on-chain.
    signal input oldCapacityCommitment;
    signal input newCapacityCommitment;
    signal input orderCommitment;
    signal input nullifier;

    // Private witness.
    signal input currentCapacity;
    signal input restoredCapacity;
    signal input orderWorkload;
    signal input currentRandomness;
    signal input restoredRandomness;
    signal input orderRandomness;
    signal input releaseNullifierSecret;

    component currentBits = Num2Bits(64);
    currentBits.in <== currentCapacity;

    component workloadBits = Num2Bits(64);
    workloadBits.in <== orderWorkload;

    component restoredBits = Num2Bits(64);
    restoredBits.in <== restoredCapacity;

    // Canonical inverse transition for an allocation whose order context is no longer current.
    // Because restoredCapacity is range-constrained to uint64 and both addends are uint64,
    // this also rules out field-wraparound and uint64 overflow.
    restoredCapacity === currentCapacity + orderWorkload;

    component oldCommit = Poseidon(7);
    oldCommit.inputs[0] <== factoryId;
    oldCommit.inputs[1] <== periodId;
    oldCommit.inputs[2] <== processId;
    oldCommit.inputs[3] <== policyHash;
    oldCommit.inputs[4] <== currentCapacity;
    oldCommit.inputs[5] <== currentRandomness;
    oldCommit.inputs[6] <== 1; // capacity-commitment domain tag
    oldCommit.out === oldCapacityCommitment;

    component nextCommit = Poseidon(7);
    nextCommit.inputs[0] <== factoryId;
    nextCommit.inputs[1] <== periodId;
    nextCommit.inputs[2] <== processId;
    nextCommit.inputs[3] <== policyHash;
    nextCommit.inputs[4] <== restoredCapacity;
    nextCommit.inputs[5] <== restoredRandomness;
    nextCommit.inputs[6] <== 1; // capacity-commitment domain tag
    nextCommit.out === newCapacityCommitment;

    // Re-open the immutable order commitment so the amount restored is exactly the amount
    // originally allocated to this order, without revealing that amount.
    component orderHash = Poseidon(4);
    orderHash.inputs[0] <== orderId;
    orderHash.inputs[1] <== orderWorkload;
    orderHash.inputs[2] <== orderRandomness;
    orderHash.inputs[3] <== 2; // order-commitment domain tag
    orderHash.out === orderCommitment;

    // Separate domain tag from spend nullifiers. The contract additionally marks the allocation
    // itself released, so neither a repeated proof nor a different release secret can restore it twice.
    component nullifierHash = Poseidon(4);
    nullifierHash.inputs[0] <== oldCapacityCommitment;
    nullifierHash.inputs[1] <== orderCommitment;
    nullifierHash.inputs[2] <== releaseNullifierSecret;
    nullifierHash.inputs[3] <== 4; // capacity-release-nullifier domain tag
    nullifierHash.out === nullifier;
}

component main { public [
    factoryId,
    periodId,
    processId,
    orderId,
    policyHash,
    oldCapacityCommitment,
    newCapacityCommitment,
    orderCommitment,
    nullifier
] } = CapacityRelease();
