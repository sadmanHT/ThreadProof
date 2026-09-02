export const THREADPROOF_BASELINE_VALIDATOR_COUNT = 5;
export const THREADPROOF_TOLERATED_UNAVAILABLE_VALIDATORS = 1;
export const THREADPROOF_SYNC_MIN_PEERS = 3;
export const THREADPROOF_HEALTHY_PEER_MINIMUM = THREADPROOF_BASELINE_VALIDATOR_COUNT - 1;

function requireInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}.`);
  }
  return value;
}

export function parseBesuSyncMinPeers(source, label = "Besu config") {
  if (typeof source !== "string") throw new Error(`${label} must be text.`);
  const matches = [...source.matchAll(/^\s*sync-min-peers\s*=\s*(\d+)\s*(?:#.*)?$/gm)];
  if (matches.length !== 1) {
    throw new Error(`${label} must define sync-min-peers exactly once; found ${matches.length}.`);
  }
  return Number(matches[0][1]);
}

export function validateQbftStartupPeerPolicy({
  validatorCount,
  toleratedUnavailableValidators,
  syncMinPeers,
  healthyPeerMinimum,
}) {
  const validators = requireInteger(validatorCount, "validatorCount", { minimum: 2 });
  const unavailable = requireInteger(
    toleratedUnavailableValidators,
    "toleratedUnavailableValidators",
  );
  const syncMinimum = requireInteger(syncMinPeers, "syncMinPeers", { minimum: 1 });
  const healthyMinimum = requireInteger(healthyPeerMinimum, "healthyPeerMinimum", { minimum: 1 });

  if (unavailable >= validators) {
    throw new Error("toleratedUnavailableValidators must be smaller than validatorCount.");
  }

  const fullHealthyRemotePeers = validators - 1;
  const remotePeersWithToleratedUnavailable = validators - unavailable - 1;
  if (remotePeersWithToleratedUnavailable < 1) {
    throw new Error("The tolerated-unavailability policy must leave at least one remote validator peer.");
  }
  if (syncMinimum > remotePeersWithToleratedUnavailable) {
    throw new Error(
      `syncMinPeers ${syncMinimum} exceeds the ${remotePeersWithToleratedUnavailable} remote validator peers ` +
        `reachable with ${unavailable} validator(s) unavailable.`,
    );
  }
  if (healthyMinimum > fullHealthyRemotePeers) {
    throw new Error(
      `healthyPeerMinimum ${healthyMinimum} exceeds the ${fullHealthyRemotePeers} remote peers in a fully healthy topology.`,
    );
  }
  if (healthyMinimum < syncMinimum) {
    throw new Error("healthyPeerMinimum must be greater than or equal to syncMinPeers.");
  }

  return {
    validatorCount: validators,
    toleratedUnavailableValidators: unavailable,
    syncMinPeers: syncMinimum,
    healthyPeerMinimum: healthyMinimum,
    fullHealthyRemotePeers,
    remotePeersWithToleratedUnavailable,
  };
}

export function validateThreadProofBaselinePeerPolicy(syncMinPeers) {
  if (syncMinPeers !== THREADPROOF_SYNC_MIN_PEERS) {
    throw new Error(
      `ThreadProof's five-validator baseline requires sync-min-peers=${THREADPROOF_SYNC_MIN_PEERS}; found ${syncMinPeers}. ` +
        "Changing the validator set or startup threshold requires an explicit network-policy review.",
    );
  }
  return validateQbftStartupPeerPolicy({
    validatorCount: THREADPROOF_BASELINE_VALIDATOR_COUNT,
    toleratedUnavailableValidators: THREADPROOF_TOLERATED_UNAVAILABLE_VALIDATORS,
    syncMinPeers,
    healthyPeerMinimum: THREADPROOF_HEALTHY_PEER_MINIMUM,
  });
}
