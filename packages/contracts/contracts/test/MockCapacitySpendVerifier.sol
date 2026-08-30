// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICapacitySpendVerifier} from "../interfaces/ICapacitySpendVerifier.sol";

/// @dev Development/test verifier only. The provenance values are explicit sentinels, not production ceremony artifacts.
contract MockCapacitySpendVerifier is ICapacitySpendVerifier {
    bytes32 public constant circuitArtifactHash =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 public constant verificationKeyHash =
        0x2222222222222222222222222222222222222222222222222222222222222222;

    bool public result = true;

    function setResult(bool nextResult) external {
        result = nextResult;
    }

    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[9] calldata
    ) external view returns (bool) {
        return result;
    }
}
