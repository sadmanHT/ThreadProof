export class WorkerClaimLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerClaimLostError";
  }
}

export function staleClaimCutoffIso(leaseSeconds: number, nowMs = Date.now()) {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("Worker lease duration must be a positive integer number of seconds.");
  }
  return new Date(nowMs - leaseSeconds * 1_000).toISOString();
}

type ClaimLeaseOptions = {
  heartbeatSeconds: number;
  renew: () => Promise<boolean>;
  label: string;
};

export type ClaimLease = {
  renewNow: () => Promise<void>;
  assertOwned: () => void;
  stop: () => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function startClaimLease(options: ClaimLeaseOptions): ClaimLease {
  if (!Number.isSafeInteger(options.heartbeatSeconds) || options.heartbeatSeconds < 1) {
    throw new Error("Worker heartbeat interval must be a positive integer number of seconds.");
  }

  let stopped = false;
  let lost: WorkerClaimLostError | null = null;
  let renewal: Promise<void> | null = null;

  const runRenewal = async () => {
    if (stopped) return;
    if (lost) throw lost;
    if (renewal) return renewal;

    renewal = (async () => {
      try {
        const stillOwned = await options.renew();
        if (!stillOwned) {
          lost = new WorkerClaimLostError(`${options.label} claim is no longer owned by this worker.`);
          throw lost;
        }
      } catch (error) {
        if (error instanceof WorkerClaimLostError) throw error;
        lost = new WorkerClaimLostError(
          `${options.label} claim could not be renewed safely: ${errorMessage(error)}`,
        );
        throw lost;
      } finally {
        renewal = null;
      }
    })();

    return renewal;
  };

  const timer = setInterval(() => {
    void runRenewal().catch(() => {
      // Ownership is checked explicitly at persistence boundaries. The interval must
      // never create an unhandled rejection while expensive work is still unwinding.
    });
  }, options.heartbeatSeconds * 1_000);
  timer.unref?.();

  return {
    renewNow: runRenewal,
    assertOwned() {
      if (lost) throw lost;
      if (stopped) throw new WorkerClaimLostError(`${options.label} claim lease has already stopped.`);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
