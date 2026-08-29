pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

/// CapacitySpend proves a single confidential capacity-state transition.
///
/// Invariants enforced by the circuit:
/// 1. the prover opens the currently referenced old commitment;
/// 2. orderWorkload <= previousCapacity;
/// 3. newCapacity = previousCapacity - orderWorkload;
/// 4. all capacity/workload values are unsigned 64-bit integers;
/// 5. the workload is bound to an order commitment;
/// 6. the next capacity commitment is derived correctly;
/// 7. the nullifier is bound to the consumed commitment and factory secret.
///
/// Exact capacities, workload and randomness remain private witness values.
template CapacitySpend() {
    // Public business/domain identifiers.
    signal input factoryId;
    signal input periodId;
    signal input processId;
    signal input orderId;
    signal input policyHash;

    // Public cryptographic state.
    signal input oldCapacityCommitment;
    signal input newCapacityCommitment;
    signal input orderCommitment;
    signal input nullifier;

    // Private witness.
    signal input previousCapacity;
    signal input newCapacity;
    signal input orderWorkload;
    signal input oldRandomness;
    signal input newRandomness;
    signal input orderRandomness;
    signal input factoryNullifierSecret;

    // Explicit unsigned range constraints avoid field-wraparound ambiguity.
    component previousBits = Num2Bits(64);
    previousBits.in <== previousCapacity;

    component workloadBits = Num2Bits(64);
    workloadBits.in <== orderWorkload;

    component newBits = Num2Bits(64);
    newBits.in <== newCapacity;

    // Feasibility: workload must fit inside the current capacity state.
    component feasible = LessEqThan(64);
    feasible.in[0] <== orderWorkload;
    feasible.in[1] <== previousCapacity;
    feasible.out === 1;

    // Canonical state transition.
    newCapacity === previousCapacity - orderWorkload;

    // Capacity commitments are domain-bound to factory, period, process and policy.
    component oldCommit = Poseidon(7);
    oldCommit.inputs[0] <== factoryId;
    oldCommit.inputs[1] <== periodId;
    oldCommit.inputs[2] <== processId;
    oldCommit.inputs[3] <== policyHash;
    oldCommit.inputs[4] <== previousCapacity;
    oldCommit.inputs[5] <== oldRandomness;
    oldCommit.inputs[6] <== 1; // capacity-commitment domain tag
    oldCommit.out === oldCapacityCommitment;

    component nextCommit = Poseidon(7);
    nextCommit.inputs[0] <== factoryId;
    nextCommit.inputs[1] <== periodId;
    nextCommit.inputs[2] <== processId;
    nextCommit.inputs[3] <== policyHash;
    nextCommit.inputs[4] <== newCapacity;
    nextCommit.inputs[5] <== newRandomness;
    nextCommit.inputs[6] <== 1; // capacity-commitment domain tag
    nextCommit.out === newCapacityCommitment;

    // Bind the exact private workload consumed by this proof to the order.
    component orderHash = Poseidon(4);
    orderHash.inputs[0] <== orderId;
    orderHash.inputs[1] <== orderWorkload;
    orderHash.inputs[2] <== orderRandomness;
    orderHash.inputs[3] <== 2; // order-commitment domain tag
    orderHash.out === orderCommitment;

    // One old state produces one factory-bound nullifier.
    component nullifierHash = Poseidon(3);
    nullifierHash.inputs[0] <== oldCapacityCommitment;
    nullifierHash.inputs[1] <== factoryNullifierSecret;
    nullifierHash.inputs[2] <== 3; // capacity-nullifier domain tag
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
] } = CapacitySpend();
