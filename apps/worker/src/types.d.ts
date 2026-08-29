declare module "circomlibjs" {
  export function buildPoseidon(): Promise<{
    F: { toString(value: unknown): string };
    (inputs: bigint[]): unknown;
  }>;
}

declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string>,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  };

  export type Groth16Proof = {
    pi_a: [string, string, string?];
    pi_b: [[string, string], [string, string], [string, string]?];
    pi_c: [string, string, string?];
    protocol?: string;
    curve?: string;
  };
}
