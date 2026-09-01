import { executeLivePofc } from "./lib/live-pofc-context";

async function main() {
  const result = await executeLivePofc();

  console.log(
    `THREADPROOF_LIVE_POFC ${JSON.stringify({
      chainId: result.chainId.toString(),
      verifier: result.verifierAddress,
      circuitArtifactHash: result.expectedCircuitHash,
      verificationKeyHash: result.expectedVerificationKeyHash,
      credentialTx: result.credentialReceipt?.hash,
      certificationTx: result.certifyReceipt?.hash,
      orderTx: result.orderReceipt?.hash,
      spendTx: result.spendReceipt?.hash,
      spendBlock: result.spendReceipt?.blockNumber.toString(),
      allocationId: result.allocationId,
      oldCommitment: result.publicSignals[5].toString(),
      newCommitment: result.publicSignals[6].toString(),
      nullifier: result.publicSignals[8].toString(),
      allocationAuthorized: true,
      tamperedSignalRejected: result.tamperedSignalRejected,
      setup: "development-only-groth16",
    })}`,
  );
  console.warn(
    "DEV ONLY: this is a real multi-validator PoFC transaction using a development Groth16 ceremony, not a production trusted setup.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
